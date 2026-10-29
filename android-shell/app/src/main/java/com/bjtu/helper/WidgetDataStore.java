package com.bjtu.helper;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 桌面小组件的数据仓库：网页推送下来的「今日课程 + 待办 DDL」快照存取。
 *
 * 为什么快照由网页推而不是原生自己拉接口：
 *   登录 token 在 WebView 的 localStorage 里，原生拿不到；网页本来就在登录态里
 *   拉过课表与 DDL，把**算好的展示数据**过一次桥最省事，也天然尊重登录/游客切换 ——
 *   账号换了，下一次推送就会覆盖快照，小组件显示的永远是「当前账号」的数据。
 *
 * 存储选 SharedPreferences 而不是文件：快照就是一份几十 KB 以内的 JSON 字符串，
 * 单键整存整取，要的只是"进程被杀后小组件还能画出上次的内容"这一件事。
 *
 * 契约见 web/src/lib/widgetBridge.ts（网页侧）与 ScheduleWidgetProvider（渲染侧）。
 * 未知字段一律忽略：网页先于壳升级时多出的字段不会炸老壳。
 */
public final class WidgetDataStore {

    private static final String PREFS = "widget";
    private static final String KEY_SNAPSHOT = "snapshot_json";

    /** 快照大小上限（160KB）：防御性配置，正常快照 < 30KB，超限视为异常直接丢弃 */
    private static final int MAX_JSON_LENGTH = 160 * 1024;

    private WidgetDataStore() {}

    /**
     * 保存快照（整包替换）。
     *
     * 用 commit() 而不是 apply()：桥线程写完立刻可能被小组件渲染线程读，
     * apply() 的异步落盘在极端时序下会让渲染拿到旧值 —— 快照很小，同步写没有代价。
     *
     * @return true = 已写入；false = 参数非法（网页侧不 toast，静默保留旧快照）
     */
    public static boolean save(Context context, String snapshotJson) {
        if (snapshotJson == null || snapshotJson.isEmpty()) return false;
        if (snapshotJson.length() > MAX_JSON_LENGTH) return false;
        try {
            /* 先本地解析一遍：把"网页 JSON 拼坏了"挡在存储之前，
               避免渲染时才发现解析失败、把上一份好数据顶掉。 */
            new JSONObject(snapshotJson);
        } catch (Exception e) {
            return false;
        }
        prefs(context).edit().putString(KEY_SNAPSHOT, snapshotJson).commit();
        return true;
    }

    /** 读当前快照；从未推送过返回 null（渲染层据此显示"打开 App 同步"引导态） */
    public static JSONObject load(Context context) {
        String raw = prefs(context).getString(KEY_SNAPSHOT, null);
        if (raw == null || raw.isEmpty()) return null;
        try {
            return new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    /* ---------- 快照字段的类型化读取（全部带缺省兜底，坏字段只影响自己那行） ---------- */

    /** 读取 days 数组（未来 7 天的每日课程），结构见 widgetBridge.ts 的 WidgetDay */
    public static JSONArray days(JSONObject snapshot) {
        return snapshot == null ? null : snapshot.optJSONArray("days");
    }

    /** 读取 tasks 数组（全部未完成 DDL，按截止时间升序），结构见 widgetBridge.ts 的 WidgetTask */
    public static JSONArray tasks(JSONObject snapshot) {
        return snapshot == null ? null : snapshot.optJSONArray("tasks");
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
