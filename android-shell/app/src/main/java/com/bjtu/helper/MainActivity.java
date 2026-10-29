package com.bjtu.helper;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.CalendarContract;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;

/**
 * bjtu-helper 原生 WebView 壳（纯 Android 框架实现，无任何三方依赖）。
 *
 * 职责：
 *  1. WebView 承载站点（默认 https://bjtuhelper.bond/app，见 {@link #HOME_URL}），开 JS / DOM Storage / 文件选择。
 *  2. 暴露 {@code window.BjtuCalendar.addEvent(payloadJson)} 原生日历桥 —— 契约见
 *     web/src/lib/calendarBridge.ts：网页可申请系统日历权限并写入事件。
 *  3. 返回键 / 侧滑返回统一走 {@link #handleBack()}（v1.7 起，见 registerBackCallback 的说明）。
 *  4. 版本更新检查：拉 {@code /download/manifest.json} 比对 versionCode，有新版本弹窗提示（v1.7 新增）。
 *  5. 桌面小组件（v1.8 新增）：网页经 {@code window.BjtuWidget.update(json)} 推送
 *     「今日课程 + 待办 DDL」快照，原生存 SharedPreferences 并重画 AppWidget
 *     （见 BjtuWidgetBridge / WidgetDataStore / ScheduleWidgetProvider）。
 *
 * 日历桥契约：payload={title,description?,location?,startISO,endISO,allDay?,reminderMinutes?,uid?}
 *   addEvent 返回："granted"=已写入 | "updated"=已更新同一条 | "pending"=已弹系统授权框、排队待写
 *                | 含"权限"字样=未授权且需去设置里开 | 其它=错误信息。
 *   网页端把 granted/updated 视为成功，"pending" 提示用户去弹窗里点允许。
 */
public class MainActivity extends Activity {

    /**
     * 站点首页，改这里即可切换环境。
     *
     * 2026-10-20：域名 `bjtuhelper.bond` 已备案，证书已签发（Let's Encrypt，acme.sh 自动续期），
     * 入口改为 https。同步做了两件事，缺一不可：
     *   ① 服务器把旧的裸 IP 入口 301 到域名，跳转后的 host 必须在 {@link #APP_HOSTS} 里，
     *      否则会被 shouldOverrideUrlLoading 甩给系统浏览器；
     *   ② AndroidManifest 的 `usesCleartextTraffic` 改为 false —— 全站 https 之后
     *      明文请求本就该被系统拦掉，留着 true 等于给降级攻击留口子。
     *
     * 旧的裸 IP 不再写进白名单：v1.3 及更早的安装包的入口地址是**编译进各自 APK** 的，
     * 与本仓库源码无关；它们被 301 之后落到的是域名，域名已在白名单内，因此新构建
     * 不再需要知道那台机器的地址。
     */
    private static final String HOME_URL = "https://bjtuhelper.bond/app";

    /**
     * 视作"站内"、留在 WebView 打开的主机（其它主机一律交给系统浏览器）。
     */
    private static final Set<String> APP_HOSTS = new HashSet<>(Arrays.asList(
            "bjtuhelper.bond",
            "www.bjtuhelper.bond"
    ));

    /** 站内主域后缀：将来新增子域（如 m./static.）时不必再改上面那张表 */
    private static final String APP_HOST_SUFFIX = ".bjtuhelper.bond";

    /**
     * 这个 URL 是否应该留在 WebView 里。
     *
     * ⚠️ 这个判断是「打开 App 就被甩进浏览器」那个事故的唯一开关，改动务必想清楚：
     *   v1.2/v1.3 的壳把「站内」写成 `url.startsWith("http://<裸IP>")`，
     *   而 2026-10-20 服务器把 http://IP 301 到了 https://bjtuhelper.bond ——
     *   跳转目标不匹配前缀，于是这个**站内跳转**被判成外链，startActivity 直接开浏览器。
     *   用户看到的就是「一打开 App 就跳到网页」，而且浏览器是另一个 origin，
     *   WebView 里存的 token 读不到，紧接着又表现成「被强制下线」。
     *
     * 现在的判定：scheme 必须是 http/https（mailto:/intent:/tel: 这类交给系统处理），
     * 主机在显式白名单里，或落在站内主域后缀下。
     */
    private static boolean shouldStayInWebView(Uri u) {
        if (u == null) return true;
        String scheme = u.getScheme();
        if (scheme == null) return true;                       // about:blank / blob: / data:
        String s = scheme.toLowerCase(Locale.ROOT);
        if (!"http".equals(s) && !"https".equals(s)) return false;
        String host = u.getHost();
        if (host == null) return true;
        String h = host.toLowerCase(Locale.ROOT);
        return APP_HOSTS.contains(h) || h.endsWith(APP_HOST_SUFFIX);
    }

    /** 首屏加载失败时展示的兜底页（见 onReceivedError 的注释）。 */
    private static String offlinePage(String reason) {
        /* 站点自身没有外链 CSS 依赖，这里全部内联，避免错误页再发一次请求又失败 */
        return "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<style>"
                + "html,body{margin:0;height:100%;background:#12141a;color:#e8eaf0;"
                + "font:16px/1.6 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif}"
                + ".wrap{max-width:420px;margin:0 auto;padding:22vh 24px 0;text-align:center}"
                + ".ico{width:56px;height:56px;margin:0 auto 18px;border-radius:50%;"
                + "background:rgba(255,255,255,.06);display:flex;align-items:center;"
                + "justify-content:center;font-size:26px}"
                + "h1{font-size:17px;font-weight:600;margin:0 0 8px}"
                + "p{font-size:13px;color:#9aa2b1;margin:0 0 22px;word-break:break-all}"
                + "a{display:inline-block;padding:11px 26px;border-radius:10px;"
                + "background:#4f7cff;color:#fff;text-decoration:none;font-size:15px}"
                + "</style></head><body><div class=\"wrap\">"
                + "<div class=\"ico\">!</div>"
                + "<h1>没能连上服务器</h1>"
                + "<p>请检查网络后重试。如果一直失败，可能是站点正在维护。<br>"
                + (reason.isEmpty() ? "" : "（" + reason + "）")
                + "</p>"
                + "<a href=\"" + HOME_URL + "\">重新加载</a>"
                + "</div></body></html>";
    }

    /**
     * UA 标记的**兜底**版本号：只有在 PackageManager 读不到 versionName 时才会用到。
     *
     * 追加到系统 WebView 默认 UA 末尾的自家标记，形如
     * `... Chrome/xx Mobile Safari/537.36 BjtuHelperApp/1.7`。
     *
     * 为什么需要它：安卓 WebView 的默认 UA 带 `; wv)`，但**微信 / QQ 内置浏览器也带**，
     * 光凭 `; wv)` 无法区分「在 App 里打开」和「在微信里点开链接」。
     * 站点首页（web/src/landing/landing.ts）用这个标记精确判定「已经在壳里」，
     * 从而不再重复弹「下载 App」引导。
     *
     * ⚠️ 版本号**不再写死**（2026-10-22 改）：v1.6 那次发版忘了同步这个常量，
     *    装的是 1.6、UA 却报 `BjtuHelperApp/1.5`，导致网页侧无法判断真实版本
     *    （老版本没有 versionCode 桥，UA 是唯一线索）。现在改为运行时读
     *    PackageManager 的 versionName，与 build.gradle 的 versionName 天然一致，
     *    不会再出现「发版忘改」这类漂移。
     *
     * 网页侧只匹配前缀 `BjtuHelperApp`，不匹配版本号，所以升版本无需改网页。
     */
    private static final String APP_UA_FALLBACK_VERSION = "1.7";

    /* ================= 版本更新检查 ================= */

    /**
     * 版本清单地址：和官网下载页读的是**同一份** JSON（`web/public/downloads/manifest.json`
     * 由服务端 `/download/manifest.json` 直接吐出）。发新版只需换 APK + 改这份清单，
     * App 里的更新提示会自动跟着走，不需要再发一次壳。
     */
    private static final String UPDATE_MANIFEST_URL = "https://bjtuhelper.bond/download/manifest.json";

    /** 下载页兜底入口：清单里的 url 解析不出来时用它（服务端 302 到当前版本） */
    private static final String UPDATE_FALLBACK_URL = "https://bjtuhelper.bond/download/latest";

    /** 自动检查的节流间隔：6 小时。用户一天开十次 App 也只会在头一次检查网络 */
    private static final long UPDATE_CHECK_INTERVAL_MS = 6L * 60 * 60 * 1000;

    private static final String PREF_UPDATE_LAST_CHECK = "update_last_check";
    private static final String PREF_UPDATE_SKIPPED = "update_skipped_code";

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private Uri cameraImageUri;

    /**
     * API 33+ 的返回回调（predictive back / 侧滑返回）。
     *
     * ⚠️ 这就是「侧滑返回直接退出到桌面」的根因所在：
     *   本壳 targetSdk = 36，Android 13 起系统优先走 OnBackInvoked 通道，
     *   若应用**没有注册** OnBackInvokedCallback，系统就把这次返回当成「没人处理」，
     *   直接 finish 掉 Activity —— 表现为侧滑一下 App 就没了，
     *   而三键导航的返回键在部分机型上仍走 onBackPressed，所以症状会不一致。
     *   解决办法是显式注册回调（见 registerBackCallback），把侧滑和返回键
     *   收敛到同一个 handleBack() 里。
     */
    private Object backInvokedCallback;

    /**
     * 当前显示的是不是首屏失败兜底页（见 onReceivedError）。
     *
     * 为什么要单独记这个状态：兜底页是 `loadDataWithBaseURL` 加载的，会进 WebView 的历史，
     * 于是 `canGoBack()` 变 true。若返回键仍走"能退就退"，用户会退回到那个**加载失败的地址**，
     * 它再失败一次、再显示兜底页 —— 按多少次都出不去，看起来像"返回键坏了"。
     * 所以显示兜底页时，返回键直接交给系统（退出 App）。
     */
    private boolean showingOfflinePage;

    private static final int REQ_CALENDAR = 1001;
    private static final int REQ_FILE = 1002;

    /** 「已经弹过一次系统授权框」的本地标记：区分"还没问过"与"用户拒绝过且系统不再弹框" */
    private static final String PREF_CAL_PERM_ASKED = "cal_perm_asked";

    /** 权限授予后补写的事件队列 */
    private final List<PendingAddEvent> pendingEvents = new ArrayList<>();

    /** 系统授权框正在显示：批量写入时不要对每条事件都重复 requestPermissions */
    private boolean permissionDialogOpen;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage 存 token/主题
        s.setDatabaseEnabled(true);
        /* 混合内容一律禁止：站点已切到 https（2026-10-20），任何 http 子资源（图片、脚本、接口）
           都会被拦下，而不是"静默加载"。
           （曾经是 MIXED_CONTENT_ALWAYS_ALLOW：那等于允许 https 页面加载 http 脚本，
             中间人可以往站点里注入任意 JS —— 而这站点里存着 token。） */
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        /* file:// 与 content:// 都不需要：图片选择走的是系统 FileProvider 返回的 content URI，
           由 onShowFileChooser 交给网页，不经过 WebView 自己的文件访问。
           关掉它们可以挡掉"网页脚本读取本机文件"这一类利用链。 */
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        /* 追加自家 UA 标记（见 APP_UA_FALLBACK_VERSION 注释）：站点据此判定「已在 App 壳内」，
           不再重复显示下载 App 的引导条；网页侧的老版本更新提示也靠它识别版本。
           必须在 loadUrl 之前设置。 */
        String uaVersion = currentVersionName();
        if (uaVersion == null || uaVersion.trim().isEmpty()) uaVersion = APP_UA_FALLBACK_VERSION;
        s.setUserAgentString(s.getUserAgentString() + " BjtuHelperApp/" + uaVersion);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                /* 站内（含 301 到新域名的那一跳）留在 WebView；其余一律交给系统。
                   注意：这里必须按**最终跳转目标**判断，不能按"起始 URL 前缀"判断 ——
                   服务器把 http://IP 301 到 https://域名 之后，前缀判断会把站内跳转误判成外链。 */
                if (shouldStayInWebView(u)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
                return true; // 外链 / 非 http(s) scheme 交给系统
            }

            /**
             * 主文档加载失败时给一个可操作的页面，而不是一片白。
             *
             * 为什么需要：本壳是全屏 WebView，没有地址栏也没有刷新按钮。
             * 一旦首屏加载失败（断网、DNS 抽风、证书链异常、学校出口被墙），
             * 用户看到的就是**纯白屏**，既不知道发生了什么，也没有任何重试入口 ——
             * 只能杀掉进程重开，重开还是白屏。这是"App 坏了"最典型的来源。
             *
             * ⚠️ 只处理主文档（isForMainFrame）：图片/接口这类子资源失败时
             *    页面本身是好的，替换成错误页反而更糟。
             * ⚠️ 错误页用 data: 加载（allowFileAccess 已关，file:// 走不通），
             *    重试按钮直接跳 HOME_URL —— 这个地址在 APP_HOSTS 里，会留在 WebView。
             */
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request == null || !request.isForMainFrame()) return;
                String desc = (error == null || error.getDescription() == null)
                        ? "" : error.getDescription().toString();
                showingOfflinePage = true;
                view.loadDataWithBaseURL(null, offlinePage(desc), "text/html", "utf-8", null);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                /* 真正加载到站内页面了 → 清掉"正在显示兜底页"的标记，
                   让返回键恢复成"WebView 内后退"而不是直接退出。
                   只认 http(s)：兜底页本身是 data: 地址，会走到这里，必须排除掉。 */
                if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                    showingOfflinePage = false;
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = cb;
                Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                if (camera.resolveActivity(getPackageManager()) != null) {
                    cameraImageUri = FileUtil.createImageUri(MainActivity.this);
                    if (cameraImageUri != null) camera.putExtra(MediaStore.EXTRA_OUTPUT, cameraImageUri);
                }
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("image/*");
                Intent chooser = Intent.createChooser(pick, "选择课表图片");
                if (cameraImageUri != null) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{camera});
                try {
                    startActivityForResult(chooser, REQ_FILE);
                } catch (Exception e) {
                    if (filePathCallback != null) { filePathCallback.onReceiveValue(null); filePathCallback = null; }
                    return false;
                }
                return true;
            }
        });

        // 暴露原生日历桥
        webView.addJavascriptInterface(new BjtuCalendarBridge(), "BjtuCalendar");
        // 暴露应用控制桥（退出等）。网页侧只有在检测到该对象时才会启用「再按一次退出」，
        // 老版本壳没有它时自动降级为静默（返回键不会真的关掉应用），不会出现点了没反应的困惑。
        webView.addJavascriptInterface(new BjtuAppBridge(), "BjtuApp");
        // 暴露文件保存桥：WebView 里 <a download> 不生效，下载必须走原生。
        // 网页侧在 lib/saveFile.ts 探测 window.BjtuDownload，没有就回退浏览器方案。
        webView.addJavascriptInterface(new BjtuDownloadBridge(), "BjtuDownload");
        /* 暴露原生 HTTP 桥：物理在线/物理实验/演示实验只对校园网开放，
           网页里直接 fetch 会被同源策略挡住，改由原生代发（见 BjtuNetBridge）。
           网页侧在 lib/deviceRelay.ts 探测 window.BjtuNet，没有就退回服务端中继。 */
        webView.addJavascriptInterface(new BjtuNetBridge(webView), "BjtuNet");
        /* 暴露小组件桥：网页把「今日课程 + 待办 DDL」快照推给原生存起来，
           供桌面小组件（ScheduleWidgetProvider）渲染。
           网页侧在 lib/widgetBridge.ts 探测 window.BjtuWidget，没有就不推（浏览器里无感）。 */
        webView.addJavascriptInterface(new BjtuWidgetBridge(), "BjtuWidget");

        /* 不再在冷启动时无条件申请日历权限（2026-10-20 改）：
           启动就弹系统框，用户还没有任何上下文，多半直接点"拒绝"；而 Android 在连续
           拒绝两次后 requestPermissions 会**静默返回**，之后点「加入日历」看起来就
           彻底失效了（既没弹框也没写进去）。现在改成用户真正点「加入日历」时再申请，
           见 BjtuCalendarBridge.addEvent()。 */

        webView.loadUrl(HOME_URL);

        /* 侧滑返回 / 返回键：API 33+ 必须显式注册回调，否则系统直接 finish（见字段注释） */
        registerBackCallback();

        /* 静默检查更新（自带 6 小时节流，失败不打扰用户）。
           放在 loadUrl 之后：首屏优先，更新检查晚几百毫秒开始完全没影响。 */
        checkForUpdate(false);
    }

    /* ================= 权限 ================= */

    private boolean hasCalendarPermission() {
        return Build.VERSION.SDK_INT < 23
                || checkSelfPermission(Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * 权限是不是"再问也没用"：问过、且系统已不允许再弹框（勾了「不再询问」或连拒两次）。
     * 这种情况只能引导用户去系统设置里手动打开，否则表现为"点了加入日历，什么都不发生"。
     */
    private boolean isCalendarPermissionBlocked() {
        if (Build.VERSION.SDK_INT < 23 || hasCalendarPermission()) return false;
        boolean asked = getPreferences(MODE_PRIVATE).getBoolean(PREF_CAL_PERM_ASKED, false);
        if (!asked) return false;   // 还没问过：不算 blocked，正常弹框即可
        try {
            return !shouldShowRequestPermissionRationale(Manifest.permission.WRITE_CALENDAR);
        } catch (Exception e) {
            return false;
        }
    }

    /** 申请写日历权限（必须在 UI 线程调用；重复调用会被 permissionDialogOpen 挡掉） */
    private void requestCalendarPermission() {
        if (Build.VERSION.SDK_INT < 23 || hasCalendarPermission() || permissionDialogOpen) return;
        permissionDialogOpen = true;
        getPreferences(MODE_PRIVATE).edit().putBoolean(PREF_CAL_PERM_ASKED, true).apply();
        try {
            requestPermissions(new String[]{Manifest.permission.WRITE_CALENDAR}, REQ_CALENDAR);
        } catch (Exception e) {
            permissionDialogOpen = false;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_CALENDAR) return;
        permissionDialogOpen = false;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted) {
            flushPendingEvents();
        } else {
            // 拒绝了就别把事件一直攒着：下次点「加入日历」会重新走一遍申请
            synchronized (pendingEvents) { pendingEvents.clear(); }
        }
    }

    /** 把授权前排队的事件补写进日历（授权回调 / 从系统设置返回后都会走这里） */
    private void flushPendingEvents() {
        List<PendingAddEvent> queue;
        synchronized (pendingEvents) {
            if (pendingEvents.isEmpty()) return;
            queue = new ArrayList<>(pendingEvents);
            pendingEvents.clear();
        }
        for (PendingAddEvent ev : queue) insertEvent(ev);
    }

    /* ================= 应用控制桥 ================= */

    /**
     * 网页侧的「再按一次退出」依赖这里。
     * 为什么需要它：首页为拦截误触，Web 层始终保留一条 history 记录，
     * 于是 WebView.canGoBack() 恒为 true，onBackPressed 永远走不到 super ——
     * 用户在最上层按返回会"毫无反应"。由网页在确认是第二次按下时主动调 exit()，
     * 既保住了误触保护，又能真的退出。
     */
    public class BjtuAppBridge {
        @JavascriptInterface
        public void exit() {
            runOnUiThread(() -> {
                finish();
                // 立即从最近任务里移除，避免退出后还留着一个空白卡片
                if (android.os.Build.VERSION.SDK_INT >= 21) finishAndRemoveTask();
            });
        }

        /** 壳的版本号（如 "1.7"），网页「关于」里显示用 */
        @JavascriptInterface
        public String versionName() {
            return currentVersionName();
        }

        /** 壳的 versionCode，网页判断"能不能用某个新桥"时比版本号更可靠 */
        @JavascriptInterface
        public int versionCode() {
            return currentVersionCode();
        }

        /** 手动检查更新：有新版弹原生对话框，没有则 Toast「已是最新版本」 */
        @JavascriptInterface
        public void checkUpdate() {
            runOnUiThread(() -> checkForUpdate(true));
        }

        /**
         * 用系统浏览器打开一个 http(s) 地址。
         *
         * 主要用途：课件 / 整目录导出这类**大文件下载**。WebView 里只能把文件读成
         * base64 再过桥（体积膨胀 33%、几十 MB 会卡住 JS 线程、全程没有任何进度），
         * 交给浏览器下载则天然有进度条与通知栏提醒。
         *
         * ⚠️ 本方法在 WebView 的 JS 桥线程被调用，startActivity 必须切回 UI 线程；
         *    因为已经"交出去"了，返回值只表示参数合法、已投递，不表示浏览器一定打开成功。
         *
         * @return true = 参数合法且已投递
         */
        @JavascriptInterface
        public boolean openUrl(String url) {
            if (url == null) return false;
            final String u = url.trim();
            if (!u.startsWith("http://") && !u.startsWith("https://")) return false;
            runOnUiThread(() -> openInBrowser(u));
            return true;
        }
    }

    /* ================= 小组件桥 ================= */

    /**
     * 网页 → 桌面小组件的数据通道。
     *
     * 为什么这么设计：登录态（token）只在 WebView 的 localStorage 里，原生拿不到；
     * 而课程/DDL 的展示口径（单双周、放假周、周次过滤、排序）网页已经算好。
     * 所以让网页把**算好的展示快照**整包推过来（见 web/src/lib/widgetBridge.ts 的契约），
     * 原生只做"存起来 + 通知小组件重画"，不做任何业务计算、不发任何网络请求。
     *
     * 时效性模型：倒计时文案（"还剩 N 天"）由小组件每次渲染时按绝对时间现算，
     * 即使快照是几天前推的，"天数"仍然是对的；只有**数据本身**变化（加/删课程、DDL）
     * 需要用户打开 App 时由网页重新推送。网页在启动与每次数据变更后都会推。
     *
     * 本方法在 WebView 的 JS 桥线程被调用：SharedPreferences.commit 与
     * AppWidgetManager.updateAppWidget 都是线程安全的，不需要切 UI 线程。
     * 推送失败一律静默 —— 小组件是"顺带受益"的能力，绝不能反过来打扰网页内的用户。
     */
    public class BjtuWidgetBridge {

        /**
         * 推送/替换快照。json 结构见 web/src/lib/widgetBridge.ts 顶部的契约注释。
         * 非法 JSON / 超大小上限会被 WidgetDataStore.save 静默丢弃（旧快照保留）。
         * 三个尺寸（2×2 / 4×2 / 4×3）共用同一份快照，一次推送全部重画。
         */
        @JavascriptInterface
        public void update(String snapshotJson) {
            if (WidgetDataStore.save(MainActivity.this, snapshotJson)) {
                BaseScheduleWidget.updateAllWidgets(MainActivity.this);
            }
        }

        /** 壳是否支持小组件桥（网页侧用来区分"老壳"与"新壳"，避免无效推送） */
        @JavascriptInterface
        public boolean supported() {
            return true;
        }
    }

    /* ================= 文件保存桥 ================= */

    /**
     * 网页 → 原生的文件保存通道。
     *
     * 为什么必须有：WebView **没有下载管理器**，网页里 `<a download href="blob:...">`
     * 的点击会被 WebView 自己吞掉 —— 表现为「点了完全没反应」，连报错都没有。
     * 这就是 App 里课件 / 成绩单 / 邮件附件下载全部失效的根因
     * （同一套网页在桌面浏览器里是正常的，所以很容易被误判成后端问题）。
     *
     * 契约见 web/src/lib/saveFile.ts：
     *   window.BjtuDownload.saveBase64(name, mime, base64) → "" 表示成功，其它为错误说明
     *
     * ⚠️ base64 而不是 blob URL：blob URL 只活在 WebView 的 JS 上下文里，
     *    原生侧读不到。base64 是自包含字符串，跨桥之后直接解码即可。
     * ⚠️ 必须 @JavascriptInterface，否则 API 17+ 上不可见。
     * ⚠️ 本方法在 WebView 的 JS 线程被调用，但 FileUtil 只用 ContentResolver，
     *    不碰 UI，所以不需要 runOnUiThread（返回值要同步给网页，异步反而没法回传）。
     */
    public class BjtuDownloadBridge {
        @JavascriptInterface
        public String saveBase64(String name, String mime, String base64) {
            if (base64 == null || base64.isEmpty()) return "文件内容为空";
            byte[] bytes;
            try {
                bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
            } catch (Exception e) {
                return "文件内容解码失败";
            }
            return FileUtil.saveBytes(MainActivity.this, name, mime, bytes);
        }
    }

    /* ================= 日历桥 ================= */

    /**
     * 网页 ↔ 系统日历。
     *
     * 契约见 web/src/lib/calendarBridge.ts。所有方法都在 WebView 的 JS 桥线程上被调用，
     * 除了 requestPermissions / startActivity 需要切回 UI 线程，其余（ContentResolver 查询与写入）
     * 在这里直接做即可 —— 返回值要同步交给网页，异步反而没法回传。
     */
    public class BjtuCalendarBridge {

        /**
         * 写入一条日历事件；没授权就先申请权限，再把事件排队等授权后补写。
         *
         * 返回值（网页按此解析，见 calendarBridge.ts）：
         *   "granted" 已新建
         *   "updated" 命中同一条并已更新（同一条 DDL 重复添加 / 改了截止时间再添加）
         *   "pending" 已弹出系统授权框、事件排队，用户点「允许」后自动补写
         *   其它       给用户看的错误说明（含"权限"字样时网页会提示去弹窗里允许）
         */
        @JavascriptInterface
        public String addEvent(String payloadJson) {
            if (payloadJson == null) return "参数为空";
            try {
                JSONObject o = new JSONObject(payloadJson);
                String title = o.optString("title", "");
                if (title.isEmpty()) return "缺少 title";
                PendingAddEvent ev = new PendingAddEvent(
                        title,
                        o.optString("description", ""),
                        o.optString("location", ""),
                        o.optString("startISO", ""),
                        o.optString("endISO", ""),
                        o.optBoolean("allDay", false),
                        // 提醒提前量由网页决定（定时 120 分钟 / 全天 720 分钟），0 表示不提醒。
                        // 早期版本这里写死 10 分钟，和界面文案「提前 2 小时」完全对不上。
                        o.optInt("reminderMinutes", 120),
                        o.optString("uid", ""));

                if (hasCalendarPermission()) return insertEvent(ev);

                if (isCalendarPermissionBlocked()) {
                    return "日历权限已被拒绝，请在系统设置里为「交大小助手」打开日历权限";
                }
                // 未授权：排队 + 弹系统框；用户点「允许」后由 onRequestPermissionsResult 补写
                synchronized (pendingEvents) { pendingEvents.add(ev); }
                runOnUiThread(MainActivity.this::requestCalendarPermission);
                return "pending";
            } catch (Exception e) {
                return "解析失败：" + e.getMessage();
            }
        }

        /** 当前权限状态："granted" | "denied"（还能弹框）| "blocked"（只能去系统设置开） */
        @JavascriptInterface
        public String permissionState() {
            if (hasCalendarPermission()) return "granted";
            return isCalendarPermissionBlocked() ? "blocked" : "denied";
        }

        /** 打开本应用的系统设置页 —— 权限被永久拒绝后唯一的出路 */
        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getPackageName()));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception ignored) {}
            });
        }
    }

    private static class PendingAddEvent {
        final String title, description, location, startISO, endISO, uid;
        final boolean allDay;
        final int reminderMinutes;
        PendingAddEvent(String t, String d, String l, String s, String e, boolean a, int rm, String u) {
            title = t; description = d; location = l; startISO = s; endISO = e;
            allDay = a; reminderMinutes = rm; uid = u;
        }
    }

    /** 事件上写一条稳定标识，便于"同一条 DDL 再点一次"时更新而不是新增一条重复事件 */
    private static final String APP_URI_PREFIX = "bjtuhelper://task/";

    /**
     * 写入（或更新）一条系统日历事件。
     *
     * 相比早期实现修了三处（2026-10-20）：
     *  ① 提醒提前量读网页传来的 reminderMinutes，不再写死 10 分钟；
     *  ② 全天 DDL 真正按全天事件写（ALL_DAY=1 + UTC 零点），以前是 00:00–23:59 的定时事件，
     *     在系统日历里会显示成"半夜的一个日程"；
     *  ③ 同一条 DDL 重复添加时更新原事件，不再越点越多。
     *
     * @return "granted" 新建成功 / "updated" 更新成功 / 其它为错误说明
     */
    private String insertEvent(PendingAddEvent ev) {
        try {
            ContentResolver cr = getContentResolver();
            long calId = CalendarHelper.ensureAppCalendar(cr);

            long start, end;
            if (ev.allDay) {
                start = utcMidnight(ev.startISO);
                end = start + 24L * 60 * 60 * 1000;
            } else {
                start = parseRfc3339(ev.startISO);
                end = parseRfc3339(ev.endISO);
                if (end <= start) end = start + 30L * 60 * 1000;   // 兜底：给半小时时长
            }

            ContentValues v = new ContentValues();
            v.put(CalendarContract.Events.CALENDAR_ID, calId);
            v.put(CalendarContract.Events.TITLE, ev.title);
            if (!ev.description.isEmpty()) v.put(CalendarContract.Events.DESCRIPTION, ev.description);
            if (!ev.location.isEmpty()) v.put(CalendarContract.Events.EVENT_LOCATION, ev.location);
            v.put(CalendarContract.Events.DTSTART, start);
            v.put(CalendarContract.Events.DTEND, end);
            v.put(CalendarContract.Events.ALL_DAY, ev.allDay ? 1 : 0);
            // 全天事件的 DTSTART 必须是 UTC 零点，时区也就固定 UTC；定时事件按本机时区
            v.put(CalendarContract.Events.EVENT_TIMEZONE, ev.allDay ? "UTC" : TimeZone.getDefault().getID());
            v.put(CalendarContract.Events.HAS_ALARM, ev.reminderMinutes > 0 ? 1 : 0);
            if (!ev.uid.isEmpty()) v.put(CalendarContract.Events.CUSTOM_APP_URI, APP_URI_PREFIX + ev.uid);

            long existingId = findEventId(cr, calId, ev);
            long eventId;
            boolean updated = existingId > 0;
            if (updated) {
                cr.update(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, existingId), v, null, null);
                eventId = existingId;
            } else {
                Uri uri;
                try {
                    uri = cr.insert(CalendarContract.Events.CONTENT_URI, v);
                } catch (Exception first) {
                    /* 个别厂商日历不认 CUSTOM_APP_URI 这一列：去掉它再插一次，
                       宁可少一个去重标识，也不要整个写入失败 */
                    v.remove(CalendarContract.Events.CUSTOM_APP_URI);
                    uri = cr.insert(CalendarContract.Events.CONTENT_URI, v);
                }
                if (uri == null) return "写入失败：系统日历拒绝";
                eventId = ContentUris.parseId(uri);
            }

            if (ev.reminderMinutes > 0) {
                // 先清旧提醒：更新事件时若直接再插一条，会变成"两个闹钟"
                try {
                    cr.delete(CalendarContract.Reminders.CONTENT_URI,
                            CalendarContract.Reminders.EVENT_ID + "=?",
                            new String[]{String.valueOf(eventId)});
                } catch (Exception ignored) {}
                try {
                    ContentValues rm = new ContentValues();
                    rm.put(CalendarContract.Reminders.EVENT_ID, eventId);
                    rm.put(CalendarContract.Reminders.MINUTES, ev.reminderMinutes);
                    rm.put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT);
                    cr.insert(CalendarContract.Reminders.CONTENT_URI, rm);
                } catch (Exception ignored) {}
            }
            return updated ? "updated" : "granted";
        } catch (Exception e) {
            return "写入失败：" + e.getMessage();
        }
    }

    /**
     * 找这条 DDL 已经写过的日历事件（没有返回 -1）。
     *
     * 先按 CUSTOM_APP_URI 里的 uid 找（改过截止时间也能命中同一条），
     * 再退一步按「标题 + 开始时间」找（旧版本写入的事件没有 uid）。
     */
    private long findEventId(ContentResolver cr, long calId, PendingAddEvent ev) {
        if (!ev.uid.isEmpty()) {
            Cursor c = null;
            try {
                c = cr.query(CalendarContract.Events.CONTENT_URI,
                        new String[]{CalendarContract.Events._ID},
                        CalendarContract.Events.CALENDAR_ID + "=? AND " + CalendarContract.Events.CUSTOM_APP_URI + "=?",
                        new String[]{String.valueOf(calId), APP_URI_PREFIX + ev.uid}, null);
                if (c != null && c.moveToFirst()) return c.getLong(0);
            } catch (Exception ignored) {
                /* 该日历不支持这一列，落到下面的标题+时间匹配 */
            } finally {
                if (c != null) c.close();
            }
        }
        Cursor c2 = null;
        try {
            long start = ev.allDay ? utcMidnight(ev.startISO) : parseRfc3339(ev.startISO);
            c2 = cr.query(CalendarContract.Events.CONTENT_URI,
                    new String[]{CalendarContract.Events._ID},
                    CalendarContract.Events.CALENDAR_ID + "=? AND " + CalendarContract.Events.TITLE
                            + "=? AND " + CalendarContract.Events.DTSTART + "=?",
                    new String[]{String.valueOf(calId), ev.title, String.valueOf(start)}, null);
            if (c2 != null && c2.moveToFirst()) return c2.getLong(0);
        } catch (Exception ignored) {
        } finally {
            if (c2 != null) c2.close();
        }
        return -1L;
    }

    /** "2026-09-07"（或完整 ISO 串）→ 该日 UTC 零点毫秒。全天事件必须用这个基准。 */
    private long utcMidnight(String iso) {
        String day = (iso == null || iso.length() < 10) ? "" : iso.substring(0, 10);
        try {
            SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
            Date d = fmt.parse(day);
            if (d != null) return d.getTime();
        } catch (Exception ignored) {}
        return System.currentTimeMillis();
    }

    /** RFC3339 "2026-09-07T10:00:00[Z|±hh:mm]" → epoch ms。失败则回退当前时间。 */
    private long parseRfc3339(String iso) {
        if (iso == null || iso.isEmpty()) return System.currentTimeMillis();
        try {
            boolean utc = iso.endsWith("Z");
            String s = iso.length() > 19 ? iso.substring(0, 19) : iso;
            SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
            if (utc) fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
            Date d = fmt.parse(s);
            return d == null ? System.currentTimeMillis() : d.getTime();
        } catch (Exception e) {
            return System.currentTimeMillis();
        }
    }

    /* ================= 文件选择结果 ================= */

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK) {
                if (data != null && data.getData() != null) result = new Uri[]{data.getData()};
                else if (cameraImageUri != null) result = new Uri[]{cameraImageUri};
            }
            if (filePathCallback != null) { filePathCallback.onReceiveValue(result); filePathCallback = null; }
            cameraImageUri = null;
        }
    }

    /* ================= 返回键 / 侧滑返回 ================= */

    /**
     * 注册 API 33+ 的返回回调。
     *
     * 为什么必须注册：`android:enableOnBackInvokedCallback="true"`（见 AndroidManifest）
     * 打开之后，返回事件只走 OnBackInvoked 通道，`onBackPressed()` **不会被调用**。
     * 没注册回调 = 系统认为无人处理 = 直接结束 Activity。
     * 用户看到的就是「侧滑返回一下 App 就退到桌面了」，而不是回到上一级。
     */
    private void registerBackCallback() {
        if (Build.VERSION.SDK_INT < 33 || backInvokedCallback != null) return;
        try {
            android.window.OnBackInvokedCallback cb = this::handleBack;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb);
            backInvokedCallback = cb;
        } catch (Exception ignored) {
            /* 极少数定制 ROM 上取不到 dispatcher：退回 onBackPressed 老通道即可 */
        }
    }

    private void unregisterBackCallback() {
        if (Build.VERSION.SDK_INT < 33 || backInvokedCallback == null) return;
        try {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(
                    (android.window.OnBackInvokedCallback) backInvokedCallback);
        } catch (Exception ignored) {
        } finally {
            backInvokedCallback = null;
        }
    }

    /**
     * 唯一的「返回」处理入口：侧滑手势与三键导航的返回键都收敛到这里。
     *
     * 顺序：
     *  ① 正在显示加载失败兜底页 → 直接退出（兜底页会进 WebView 历史，
     *     "能退就退"会退回到那个加载失败的地址，再失败一次再显示兜底页，
     *     按多少次都出不去 —— 见 showingOfflinePage 的注释）；
     *  ② WebView 还能后退 → 后退一级（网页侧再用 popstate 弹自己的 UI 栈）；
     *  ③ 都不行 → 结束 Activity。
     */
    private void handleBack() {
        if (showingOfflinePage) { finish(); return; }
        if (webView != null && webView.canGoBack()) { webView.goBack(); return; }
        finish();
    }

    @Override
    public void onBackPressed() {
        /* API 33+ 走的是 OnBackInvokedCallback，这里只服务 API 24~32 */
        handleBack();
    }

    /**
     * 从系统设置页授权后返回 App：把之前排队的事件补写进日历。
     * （不这样做的话，用户去设置里打开了权限、回来还得再点一次「加入日历」。）
     */
    @Override
    protected void onResume() {
        super.onResume();
        if (hasCalendarPermission()) flushPendingEvents();
    }

    @Override
    protected void onDestroy() {
        unregisterBackCallback();
        if (webView != null) { webView.loadUrl("about:blank"); webView.destroy(); webView = null; }
        super.onDestroy();
    }

    /* ================= 版本更新 ================= */

    private int currentVersionCode() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private String currentVersionName() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.versionName == null ? "" : pi.versionName;
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * 检查更新。
     *
     * @param manual true = 用户主动点的「检查更新」（失败要提示、已最新要提示、忽略节流）；
     *               false = 启动时静默检查（失败无声、6 小时内不重复请求）。
     *
     * 提示策略：新版本只弹一次。用户点「稍后」会把 versionCode 记进本地，
     * 之后同一个版本不再打扰（下一个版本来了仍会提示）；主动检查则总是弹。
     */
    private void checkForUpdate(boolean manual) {
        final long now = System.currentTimeMillis();
        long last = getPreferences(MODE_PRIVATE).getLong(PREF_UPDATE_LAST_CHECK, 0L);
        if (!manual && now - last < UPDATE_CHECK_INTERVAL_MS) return;
        getPreferences(MODE_PRIVATE).edit().putLong(PREF_UPDATE_LAST_CHECK, now).apply();

        new Thread(() -> {
            String json = null;
            try {
                json = httpGet(UPDATE_MANIFEST_URL);
            } catch (Exception ignored) {
            }
            final String body = json;
            runOnUiThread(() -> {
                if (body == null) {
                    if (manual) Toast.makeText(this, "检查更新失败，请检查网络后重试", Toast.LENGTH_SHORT).show();
                    return;
                }
                try {
                    JSONObject m = new JSONObject(body);
                    int remoteCode = m.optInt("versionCode", 0);
                    String remoteName = m.optString("versionName", "");
                    int localCode = currentVersionCode();
                    if (remoteCode <= localCode) {
                        if (manual) {
                            Toast.makeText(this, "已是最新版本 v" + currentVersionName(), Toast.LENGTH_SHORT).show();
                        }
                        return;
                    }
                    int skipped = getPreferences(MODE_PRIVATE).getInt(PREF_UPDATE_SKIPPED, 0);
                    if (!manual && skipped == remoteCode) return;

                    String apkUrl = resolveApkUrl(m.optString("url", ""));
                    showUpdateDialog(remoteCode, remoteName, apkUrl, m.optJSONArray("changelog"),
                            m.optLong("sizeBytes", 0));
                } catch (Exception e) {
                    if (manual) Toast.makeText(this, "检查更新失败：" + e.getMessage(), Toast.LENGTH_SHORT).show();
                }
            });
        }, "bjtu-update-check").start();
    }

    /** 清单里的 url 可能是相对路径（/download/xxx.apk），拼成绝对地址才能交给浏览器 */
    private String resolveApkUrl(String url) {
        if (url == null || url.isEmpty()) return UPDATE_FALLBACK_URL;
        if (url.startsWith("http://") || url.startsWith("https://")) return url;
        String origin = UPDATE_MANIFEST_URL.substring(0, UPDATE_MANIFEST_URL.indexOf('/', 8));
        return origin + (url.startsWith("/") ? url : "/" + url);
    }

    /** 安装包体积文案：APK 只有几十 KB，统一按 MB 保留一位会显示成 "0.0MB"，小于 1MB 时改用 KB */
    private static String formatSize(long bytes) {
        if (bytes >= 1048576L) return String.format(Locale.US, "%.1fMB", bytes / 1048576.0);
        return Math.max(1L, Math.round(bytes / 1024.0)) + "KB";
    }

    private void showUpdateDialog(int code, String name, String apkUrl, JSONArray changelog, long sizeBytes) {
        if (isFinishing()) return;
        StringBuilder msg = new StringBuilder();
        if (sizeBytes > 0) {
            msg.append("安装包 ").append(formatSize(sizeBytes)).append("\n\n");
        }
        if (changelog != null && changelog.length() > 0) {
            for (int i = 0; i < changelog.length() && i < 6; i++) {
                msg.append("· ").append(changelog.optString(i, "")).append('\n');
            }
            msg.append('\n');
        }
        msg.append("更新会覆盖安装，登录状态与本地设置都会保留。");

        new AlertDialog.Builder(this)
                .setTitle("发现新版本 v" + (name.isEmpty() ? String.valueOf(code) : name))
                .setMessage(msg.toString())
                .setPositiveButton("立即更新", (d, w) -> openInBrowser(apkUrl))
                .setNegativeButton("稍后", (d, w) ->
                        getPreferences(MODE_PRIVATE).edit().putInt(PREF_UPDATE_SKIPPED, code).apply())
                .show();
    }

    /** 极简 GET（只用于取几 KB 的版本清单，不引入任何三方库） */
    private String httpGet(String urlStr) throws Exception {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("Accept", "application/json");
            conn.setInstanceFollowRedirects(true);
            if (conn.getResponseCode() != 200) return null;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            return sb.toString();
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** 交给系统浏览器打开（下载安装包 / 课件等）。只放行 http(s)，避免被网页当成任意 intent 跳板 */
    private boolean openInBrowser(String url) {
        if (url == null) return false;
        String u = url.trim();
        if (!u.startsWith("http://") && !u.startsWith("https://")) return false;
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

}
