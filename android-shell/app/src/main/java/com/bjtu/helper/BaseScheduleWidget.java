package com.bjtu.helper;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * 桌面小组件公共基类：三个尺寸（2×2 紧凑 / 4×2 标准 / 4×3 完整）共享的
 * 数据读取、文案格式化、点击意图与刷新入口。
 *
 * 数据从哪来：见 {@link WidgetDataStore} —— 网页在壳内通过 window.BjtuWidget.update(json)
 * 推送快照，这里只负责"把快照画出来"，**自己不发任何网络请求**。
 * 这样做的原因：登录 token 只在 WebView 的 localStorage 里，原生拿不到；
 * 而且课表/DDL 的展示规则（单双周、放假周、周次过滤）网页已经算好，原生再复刻一遍
 * 迟早出现两边口径不一致的 bug。
 *
 * 时效性（为什么"还剩 N 天"不会停在旧文案）：
 *   快照里存的是**绝对时间**（dueDate/dueTime 字符串），倒计时文案是每次渲染时现算的 ——
 *   即使 App 一周没打开，系统按 updatePeriodMillis（30 分钟）+ 日期变更广播
 *   反复触发 onUpdate，文案始终新鲜。只有"课程/DDL 本身变了"才依赖用户打开 App 推新快照。
 *
 * 为什么三个尺寸是三个 receiver 而不是一个：桌面选择器的每个条目对应一个
 * AppWidgetProvider；一个 provider 只能有一个默认尺寸，靠用户手动 resize 发现不了。
 * 三个条目共用同一份快照与格式化逻辑（本类），只是布局与默认格子不同 ——
 * 这也是网页端快照协议不用改的原因。
 */
abstract class BaseScheduleWidget extends AppWidgetProvider {

    private static final String[] WEEKDAY_CN = {"周日", "周一", "周二", "周三", "周四", "周五", "周六"};

    /** 全组件只有一个点击目标（打开 App），requestCode 固定即可 */
    static final int RC_OPEN_APP = 41;

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        refresh(context, appWidgetManager, appWidgetIds);
    }

    /**
     * 日期变更 / 时区变更 → 倒计时文案与"今天"的定位都过时了，立即重画。
     *
     * ⚠️ 就算这两个广播在某些 ROM 上收不到也不会坏：updatePeriodMillis 每 30 分钟
     *    会兜底刷一次，代价只是跨天时的课程列表最多晚半小时切换。
     */
    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent == null ? null : intent.getAction();
        if (Intent.ACTION_DATE_CHANGED.equals(action) || Intent.ACTION_TIMEZONE_CHANGED.equals(action)) {
            AppWidgetManager mgr = AppWidgetManager.getInstance(context);
            refresh(context, mgr, mgr.getAppWidgetIds(componentName(context)));
        }
    }

    /** 渲染本尺寸的全部实例；列表型尺寸同时通知 ListView 重查数据（快照可能已变） */
    private void refresh(Context context, AppWidgetManager mgr, int[] ids) {
        if (ids == null || ids.length == 0) return;
        int listId = listViewId();
        /* 列表适配器按 appWidgetId 绑定（setRemoteAdapter 三参形式），必须逐 id 构建 RemoteViews */
        for (int id : ids) {
            mgr.updateAppWidget(id, build(context, id));
            if (listId != 0) mgr.notifyAppWidgetViewDataChanged(id, listId);
        }
    }

    /** 本尺寸对应的 receiver 组件（updateAll 用） */
    abstract ComponentName componentName(Context context);

    /** 构建本尺寸的 RemoteViews（appWidgetId 用于给每个实例绑各自的列表适配器） */
    abstract RemoteViews build(Context context, int appWidgetId);

    /** 列表视图 id；纯固定布局的尺寸返回 0（无列表、无需通知数据变化） */
    abstract int listViewId();

    /** 网页推送新快照后由 {@code MainActivity.BjtuWidgetBridge} 调用：重画三个尺寸的全部实例 */
    static void updateAllWidgets(Context context) {
        for (Class<? extends BaseScheduleWidget> c : new Class[]{
                ScheduleWidgetProvider.class, ScheduleWidgetMediumProvider.class, ScheduleWidgetSmallProvider.class}) {
            try {
                BaseScheduleWidget w = c.getDeclaredConstructor().newInstance();
                AppWidgetManager mgr = AppWidgetManager.getInstance(context);
                int[] ids = mgr.getAppWidgetIds(w.componentName(context));
                if (ids == null || ids.length == 0) continue;
                int listId = w.listViewId();
                for (int id : ids) {
                    mgr.updateAppWidget(id, w.build(context, id));
                    if (listId != 0) mgr.notifyAppWidgetViewDataChanged(id, listId);
                }
            } catch (Exception ignored) {
                /* 反射构造失败等同于该尺寸不可用，跳过即可 */
            }
        }
    }

    /** 整个组件的点击目标：打开 App（深链到具体 tab 等以后再考虑） */
    static PendingIntent openAppIntent(Context context) {
        Intent open = new Intent(context, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(context, RC_OPEN_APP, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** 顶栏日期：「10月24日 周六」 */
    static String todayLabel() {
        Calendar now = Calendar.getInstance();
        return new SimpleDateFormat("M月d日", Locale.CHINA).format(now.getTime())
                + " " + WEEKDAY_CN[now.get(Calendar.DAY_OF_WEEK) - 1];
    }

    /** 周次后缀（仅当快照包含今天时才有意义）：「 · 第5教学周 / 放假周 / 开学前 / 已结课」 */
    static String weekLabel(JSONObject snap) {
        if (snap == null || todayInSnapshot(snap) == null) return "";
        String state = snap.optString("weekState", "");
        if ("active".equals(state)) return " · 第" + snap.optInt("weekNumber", 0) + "教学周";
        if ("holiday".equals(state)) return " · 放假周";
        if ("before".equals(state)) return " · 开学前";
        if ("after".equals(state)) return " · 已结课";
        return "";
    }

    /* ================= 最近 DDL ================= */

    /** 底部 DDL 行的渲染结果（文案 + 颜色档位），供三个尺寸共用 */
    static final class DdlLine {
        final String title;
        /** urgent=红（逾期/今天且 12h 内） mid=品牌色（今天） dim=灰（其余/无待办） */
        final boolean urgent, mid;
        final String countdown;
        DdlLine(String title, String countdown, boolean urgent, boolean mid) {
            this.title = title;
            this.countdown = countdown;
            this.urgent = urgent;
            this.mid = mid;
        }
    }

    /**
     * 最近一条未完成 DDL → 标题 + 倒计时。
     * 网页推送前已按截止时间升序排好 → 第 0 条就是最急的（含逾期的最老一条）。
     */
    static DdlLine nextDdl(JSONObject snap) {
        JSONArray tasks = WidgetDataStore.tasks(snap);
        JSONObject first = (tasks != null && tasks.length() > 0) ? tasks.optJSONObject(0) : null;
        if (first == null) {
            return new DdlLine(snap == null ? "暂无数据" : "暂无待办 DDL", "", false, false);
        }

        String dueDate = first.optString("dueDate", "");
        String dueTime = first.optString("dueTime", "");
        long day0 = startOfDay(dueDate);
        long due;
        if (dueTime.matches("\\d{1,2}:\\d{2}")) {
            String[] hm = dueTime.split(":");
            due = day0 + Long.parseLong(hm[0]) * 3600_000 + Long.parseLong(hm[1]) * 60_000;
        } else {
            due = day0 + 23L * 3600_000 + 59 * 60_000;   // 没填截止时间 = 当天最后一刻
        }

        long now = System.currentTimeMillis();
        int dayDiff = (int) Math.round((day0 - startOfToday()) / 86400000.0);

        String countdown;
        boolean urgent;
        boolean mid;
        if (dayDiff < 0) {
            /* 跨了天才叫"逾期"：当天过了截止时刻是"今天已截止"，
               与网页端 overview 的按日分桶口径一致（不然上午 10 点截止、10 点半看卡片
               会显示"已逾期 1 天"） */
            countdown = "已逾期 " + Math.max(1, -dayDiff) + " 天";
            urgent = true;
            mid = false;
        } else if (dayDiff == 0 && due < now) {
            countdown = "今天已截止";
            urgent = true;
            mid = false;
        } else if (dayDiff == 0) {
            urgent = due - now < 12L * 3600_000;
            mid = !urgent;
            countdown = dueTime.isEmpty() ? "今天截止" : "今天 " + dueTime + " 截止";
        } else if (dayDiff == 1) {
            countdown = dueTime.isEmpty() ? "明天截止" : "明天 " + dueTime + " 截止";
            urgent = false;
            mid = false;
        } else {
            countdown = "还剩 " + dayDiff + " 天";
            urgent = false;
            mid = false;
        }

        return new DdlLine(ddlTitle(first), countdown, urgent, mid);
    }

    /** 「课程 · 标题」，带考试/作业类型前缀；都没有就用裸标题 */
    static String ddlTitle(JSONObject task) {
        String type = task.optString("type", "");
        String typePrefix = "exam".equals(type) ? "考试 · " : "homework".equals(type) ? "作业 · " : "";
        String course = task.optString("courseName", "");
        String title = task.optString("title", "");
        if (!course.isEmpty()) return course + " · " + title;
        if (!typePrefix.isEmpty()) return typePrefix + title;
        return title;
    }

    /**
     * 渲染底部 DDL 行（widget_schedule 与 widget_small 共用同一组 id：
     * ddl_title / ddl_countdown）。空态（暂无待办）倒计时留空、颜色取灰。
     */
    static void renderDdlFooter(Context ctx, RemoteViews rv, JSONObject snap) {
        DdlLine line = nextDdl(snap);
        rv.setTextViewText(R.id.ddl_title, line.title);
        rv.setTextViewText(R.id.ddl_countdown, line.countdown);
        rv.setTextColor(R.id.ddl_countdown, ctx.getColor(
                line.urgent ? R.color.widget_danger : line.mid ? R.color.widget_accent : R.color.widget_secondary));
    }

    /* ================= 下一节课（2×2 紧凑卡用） ================= */
    /** 当前/下一节课的展示信息，找不到（今天没课且快照里没有明天）时 desc 为 null */
    static final class NextCourse {
        final String label;      // 「下一节 14:00 / 正在上 · 至15:50 / 明天首节 08:00」
        final String name;
        final String place;      // 教室（可为空串）
        final boolean ongoing;
        NextCourse(String label, String name, String place, boolean ongoing) {
            this.label = label; this.name = name; this.place = place; this.ongoing = ongoing;
        }
    }

    /**
     * 今天正在上/下一节课；今天没有更多课时回退到明天首节（快照是整周 Mon..Sun，
     * 周日那天快照里没有周一 —— 那就显示"今天没有更多课"）。
     */
    static NextCourse nextCourse(JSONObject snap) {
        JSONObject today = todayInSnapshot(snap);
        JSONArray courses = today == null ? null : today.optJSONArray("courses");
        long now = System.currentTimeMillis();
        if (courses != null) {
            for (int i = 0; i < courses.length(); i++) {
                JSONObject c = courses.optJSONObject(i);
                if (c == null) continue;
                long start = hmOrMin(c.optString("start", ""));
                if (start == Long.MIN_VALUE) continue;
                String endStr = c.optString("end", "");
                long end = endStr.matches("\\d{1,2}:\\d{2}")
                        ? hmOrMin(endStr)
                        : startOfToday() + 86400000L;   // 没写结束时间 = 全天有效
                if (end > now) {
                    boolean ongoing = start <= now;
                    String label = ongoing
                            ? "正在上 · 至" + c.optString("end", "")
                            : "下一节 " + c.optString("start", "");
                    return new NextCourse(label, c.optString("name", ""), c.optString("location", ""), ongoing);
                }
            }
        }
        /* 今天已无课 → 明天首节（明天 = 日历上的下一天；快照不含跨周的明天） */
        String tomorrow = new SimpleDateFormat("yyyy-MM-dd", Locale.US)
                .format(new Date(startOfToday() + 86400000L));
        JSONObject tDay = dayInSnapshot(snap, tomorrow);
        if (tDay != null) {
            JSONArray tCourses = tDay.optJSONArray("courses");
            JSONObject first = (tCourses != null && tCourses.length() > 0) ? tCourses.optJSONObject(0) : null;
            if (first != null) {
                return new NextCourse("明天首节 " + first.optString("start", ""),
                        first.optString("name", ""), first.optString("location", ""), false);
            }
        }
        return null;
    }

    /* ================= 工具 ================= */

    /**
     * 在快照 days 里找今天（按 YYYY-MM-DD 字符串比对）。
     * 找不到 = 快照是"过去的周"推的（跨了周没打开 App），课程区显示过期引导。
     */
    static JSONObject todayInSnapshot(JSONObject snap) {
        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        return dayInSnapshot(snap, today);
    }

    static JSONObject dayInSnapshot(JSONObject snap, String yyyyMMdd) {
        JSONArray days = WidgetDataStore.days(snap);
        if (days == null) return null;
        for (int i = 0; i < days.length(); i++) {
            JSONObject d = days.optJSONObject(i);
            if (d != null && yyyyMMdd.equals(d.optString("date", ""))) return d;
        }
        return null;
    }

    /** "#RRGGBB" / "#AARRGGBB" → int；解析失败用 fallback（课程默认色与网页端一致） */
    static int parseColor(String hex, int fallback) {
        try {
            return Color.parseColor(hex);
        } catch (Exception e) {
            return fallback;
        }
    }

    /** "HH:mm" → 今天该时刻的毫秒；格式非法返回 Long.MIN_VALUE（调用方跳过该行） */
    static long hmOrMin(String hhmm) {
        if (!hhmm.matches("\\d{1,2}:\\d{2}")) return Long.MIN_VALUE;
        String[] p = hhmm.split(":");
        return startOfToday() + Long.parseLong(p[0]) * 3600_000L + Long.parseLong(p[1]) * 60_000L;
    }

    /** "yyyy-MM-dd" → 当地时区当天 00:00 的毫秒；解析失败回退今天（文案会显示成今天/逾期，不会崩） */
    static long startOfDay(String yyyyMMdd) {
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            Date d = f.parse(yyyyMMdd);
            if (d != null) {
                Calendar c = Calendar.getInstance();
                c.setTime(d);
                c.set(Calendar.HOUR_OF_DAY, 0);
                c.set(Calendar.MINUTE, 0);
                c.set(Calendar.SECOND, 0);
                c.set(Calendar.MILLISECOND, 0);
                return c.getTimeInMillis();
            }
        } catch (Exception ignored) {}
        return startOfToday();
    }

    static long startOfToday() {
        Calendar c = Calendar.getInstance();
        c.set(Calendar.HOUR_OF_DAY, 0);
        c.set(Calendar.MINUTE, 0);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }
}
