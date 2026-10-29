package com.bjtu.helper;

import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 原生 HTTP 桥（window.BjtuNet）—— 「手机直连校园网」的那条出口。
 *
 * <h3>为什么需要它</h3>
 * 物理在线 / 物理实验 / 演示实验这三个站点只对校园网开放，而服务器在公网机房，
 * 直连会被学校防火墙丢包。手机连在校园网 WiFi 时本来就能访问它们，但网页里的
 * fetch/XHR 会被同源策略挡住（读不到响应体）。原生 HTTP 没有同源策略，
 * 所以由这一层代发请求，把原始字节回传给服务端解析（解析逻辑仍然只有一份）。
 *
 * <h3>协议</h3>
 * JS 调 {@code BjtuNet.fetch(JSON)}，参数形如
 * {@code {id, url, method, headers:{...}, bodyB64}}；
 * 原生完成后回调 {@code window.__bjtuNetResult(id, JSON)}，JSON 形如
 * {@code {status, headers:{...}, bodyB64, error?}}。
 * 这是**异步回调**而不是返回值：JavascriptInterface 的返回值只能是基本类型，
 * 而且网络请求本来就必须离开主线程。
 *
 * <h3>几条硬性约定</h3>
 * - **不跟随重定向**：跳转由服务端逐跳处理（演示实验的「登录成功」判据就是 302 的 Location）。
 * - **Cookie 由服务端给**：每次请求的 Cookie 头来自服务端的会话池，这里不维护 jar，
 *   否则同一账号在两处各存一份，失效时机对不上。
 * - 回传的 body 是 **base64 原始字节**：wlsy 是 GBK 页面，这里一旦按 UTF-8 解成字符串就毁了。
 */
public class BjtuNetBridge {

    private static final String TAG = "BjtuNet";
    /** 单个响应体上限，与服务端 MAX_BODY_BYTES(4MB) 留足余量 */
    private static final int MAX_BYTES = 12 * 1024 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;

    /** 目标主机白名单（评审 D2，2026-10-23）：口径与 server/src/mis.ts 的
     *  isAllowedRedirectHost 一致 —— *.bjtu.edu.cn / *.edu.cn，外加智慧课程平台的
     *  默认地址（与 mis.ts 的 _EXTRA_ALLOWED_HOSTS 同值）。
     *  为什么必须限：网页内容可被 XSS/注入操纵，桥不限目标 = 设备端 SSRF 原语
     *  （可探内网、打任意地址）。此前靠"外链甩浏览器 + CSP + 内容嗅探"三层恰好
     *  挡住，但那是脆弱结论 —— 这里补一道结构性闸门。 */
    private static final String[] ALLOWED_SUFFIXES = {".bjtu.edu.cn", ".edu.cn"};
    private static final String EXTRA_ALLOWED_HOSTPORT = "123.121.147.7:88";

    private static boolean isAllowedTarget(URL url) {
        String scheme = url.getProtocol() == null ? "" : url.getProtocol().toLowerCase();
        if (!"http".equals(scheme) && !"https".equals(scheme)) return false;
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase();
        if (host.length() == 0) return false;
        int port = url.getPort();
        String hostPort = port == -1 ? host : host + ":" + port;
        if (hostPort.equals(EXTRA_ALLOWED_HOSTPORT)) return true;
        for (String suf : ALLOWED_SUFFIXES) {
            if (host.endsWith(suf)) return true;
        }
        return false;
    }

    private final WebView webView;
    /** 并发 3：一次快照最多并发拉几门课，再多只会把手机网络打满 */
    private final ExecutorService pool = Executors.newFixedThreadPool(3);

    public BjtuNetBridge(WebView webView) {
        this.webView = webView;
    }

    /** 供网页调用：发起一次请求，结果通过 window.__bjtuNetResult 回来 */
    @JavascriptInterface
    public void fetch(final String reqJson) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                handle(reqJson);
            }
        });
    }

    private void handle(String reqJson) {
        String id = "";
        try {
            JSONObject req = new JSONObject(reqJson);
            id = req.optString("id", "");
            JSONObject out = perform(req);
            deliver(id, out.toString());
        } catch (Throwable t) {
            Log.w(TAG, "原生请求失败: " + t);
            try {
                JSONObject err = new JSONObject();
                err.put("status", 0);
                err.put("headers", new JSONObject());
                err.put("bodyB64", "");
                err.put("error", describe(t));
                deliver(id, err.toString());
            } catch (Throwable ignored) {
                // 连错误对象都构造不出来就算了，服务端会超时降级到中继机器
            }
        }
    }

    private JSONObject perform(JSONObject req) throws Exception {
        URL url = new URL(req.getString("url"));
        /* 白名单在发起连接**之前**判：不合规直接报错，一个字节都不发 */
        if (!isAllowedTarget(url)) {
            throw new IllegalArgumentException("目标主机不在白名单内（仅允许 *.bjtu.edu.cn / *.edu.cn）");
        }
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setInstanceFollowRedirects(false);
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setRequestMethod(req.optString("method", "GET"));
        conn.setUseCaches(false);

        boolean acceptEncodingSet = false;
        JSONObject headers = req.optJSONObject("headers");
        if (headers != null) {
            Iterator<String> it = headers.keys();
            while (it.hasNext()) {
                String key = it.next();
                /* Host / Content-Length 由 HttpURLConnection 自己管，硬塞会抛异常 */
                if (key.equalsIgnoreCase("host") || key.equalsIgnoreCase("content-length")) continue;
                if (key.equalsIgnoreCase("accept-encoding")) acceptEncodingSet = true;
                conn.setRequestProperty(key, headers.optString(key, ""));
            }
        }
        /* 不让底层自动 gzip：服务端拿到的是原始字节，解压交给它统一处理 */
        if (!acceptEncodingSet) conn.setRequestProperty("Accept-Encoding", "identity");

        /* ⚠️ 两个坑，2026-10-22 演示实验 405 就是这里踩的：
           1. Android 自带的 org.json 里 `optString("bodyB64","")` 遇到 JSON `null`
              返回的是**字符串 "null"**，不是默认值 —— 于是下面
              `length() > 0` 成立，会给一个本来没有 body 的 GET 写 3 个字节。
           2. `HttpURLConnection.setDoOutput(true)` 会把 **GET 悄悄改成 POST**。
              两者叠加 = 手机出口发出的每个 GET 都变成 POST。wlsy（ASP.NET）能容忍，
              所以物理实验看起来正常；演示实验的 /phydemo/appointment/ 只认 GET，直接 405。
           服务端已经改成"没有 body 就不发 bodyB64 字段"，但这里也必须修，
           否则以后哪个调用方又传个 null 就重演。 */
        String method = req.optString("method", "GET");
        String bodyB64 = req.isNull("bodyB64") ? "" : req.optString("bodyB64", "");
        boolean methodTakesBody = !"GET".equalsIgnoreCase(method) && !"HEAD".equalsIgnoreCase(method);
        if (bodyB64 != null && bodyB64.length() > 0 && methodTakesBody) {
            byte[] body = Base64.decode(bodyB64, Base64.DEFAULT);
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(body.length);
            OutputStream os = conn.getOutputStream();
            try {
                os.write(body);
                os.flush();
            } finally {
                os.close();
            }
        }

        int status = conn.getResponseCode();

        JSONObject outHeaders = new JSONObject();
        for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
            String name = entry.getKey();
            if (name == null) continue;
            List<String> values = entry.getValue();
            if (values == null || values.isEmpty()) continue;
            if (values.size() == 1) {
                outHeaders.put(name, values.get(0));
            } else {
                /* set-cookie 会有多条，必须保留成数组，否则服务端只看到一条，会话就断了一半 */
                JSONArray arr = new JSONArray();
                for (String v : values) arr.put(v);
                outHeaders.put(name, arr);
            }
        }

        InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
        byte[] bytes = readAll(is);

        JSONObject out = new JSONObject();
        out.put("status", status);
        out.put("headers", outHeaders);
        out.put("bodyB64", bytes == null ? "" : Base64.encodeToString(bytes, Base64.NO_WRAP));
        conn.disconnect();
        return out;
    }

    private static byte[] readAll(InputStream is) throws Exception {
        if (is == null) return new byte[0];
        ByteArrayOutputStream bos = new ByteArrayOutputStream(8192);
        byte[] buf = new byte[8192];
        int n;
        int total = 0;
        try {
            while ((n = is.read(buf)) > 0) {
                total += n;
                if (total > MAX_BYTES) throw new IllegalStateException("响应体超过 12MB");
                bos.write(buf, 0, n);
            }
        } finally {
            is.close();
        }
        return bos.toByteArray();
    }

    /** 把结果送回网页。evaluateJavascript 必须在主线程，且字符串要按 JS 字面量转义 */
    private void deliver(final String id, final String json) {
        final String js = "window.__bjtuNetResult(" + JSONObject.quote(id) + "," + JSONObject.quote(json) + ")";
        webView.post(new Runnable() {
            @Override
            public void run() {
                try {
                    webView.evaluateJavascript(js, null);
                } catch (Throwable t) {
                    Log.w(TAG, "回传结果失败: " + t);
                }
            }
        });
    }

    private static String describe(Throwable t) {
        String msg = t.getMessage();
        if (msg == null || msg.length() == 0) return t.getClass().getSimpleName();
        return t.getClass().getSimpleName() + ": " + msg;
    }
}
