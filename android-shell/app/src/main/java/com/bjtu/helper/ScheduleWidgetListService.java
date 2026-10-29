package com.bjtu.helper;

import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 课程列表的供数服务：给 4×3 完整版（两行式课程行）与 4×2 标准版（单行紧凑行）
 * 的 ListView 提供行数据。
 *
 * 为什么用 ListView 而不是固定 N 行：一天可能有 5~6 节课，固定行数要么装不下
 * 要么下半截全空（v1.8 被"4×3 只用了一半"诟病的根因）。列表随内容伸缩、
 * 超出可滚动，2×2 以外的两个尺寸共用同一个服务，只是行样式不同（EXTRA_MODE）。
 *
 * 行结构（onDataSetChanged 一次性从快照算好）：
 *   [今天课程…]（按开始时间升序，第一门未结束的标"现在/下一节"）
 *   今天 0 节课 → 提示行「今天没有课」+ 明天的课程预览（置灰，时间列标"明天"）
 *   无快照 / 快照不含今天（跨周未打开 App）→ 引导行
 *
 * ⚠️ Manifest 里必须带 android:permission="android.permission.BIND_REMOTEVIEWS"：
 *    只有系统（Launcher）能绑这个服务，行数据只经系统之手进桌面。
 */
public class ScheduleWidgetListService extends RemoteViewsService {

    /** 行样式模式：两行式（4×3） / 单行紧凑（4×2） */
    static final String EXTRA_MODE = "mode";
    static final int MODE_FULL = 0;
    static final int MODE_COMPACT = 1;

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        boolean compact = intent.getIntExtra(EXTRA_MODE, MODE_FULL) == MODE_COMPACT;
        return new CourseFactory(getApplicationContext(), compact);
    }

    /* ================= 工厂 ================= */

    static final class CourseFactory implements RemoteViewsFactory {

        private static final int TYPE_COURSE = 0;
        private static final int TYPE_NOTE = 1;

        /** 渲染前算好的一行数据 */
        private static final class Row {
            int type;
            /* 课程行 */
            String color, name, place, tStart, tEnd;
            boolean ongoing, tomorrow;
            /* 提示行 */
            String note;
        }

        private final Context ctx;
        private final boolean compact;
        private final List<Row> rows = new ArrayList<>();

        CourseFactory(Context ctx, boolean compact) {
            this.ctx = ctx;
            this.compact = compact;
        }

        @Override
        public void onCreate() {}

        @Override
        public void onDataSetChanged() {
            rows.clear();
            JSONObject snap = WidgetDataStore.load(ctx);
            if (snap == null) {
                rows.add(note("打开 App，同步今日课程与 DDL"));
                return;
            }
            JSONObject today = BaseScheduleWidget.todayInSnapshot(snap);
            if (today == null) {
                rows.add(note("课表已过期，打开 App 刷新今日课程"));
                return;
            }

            JSONArray courses = today.optJSONArray("courses");
            long now = System.currentTimeMillis();
            boolean sawUpcoming = false;
            if (courses != null) {
                for (int i = 0; i < courses.length(); i++) {
                    JSONObject c = courses.optJSONObject(i);
                    if (c == null) continue;
                    Row r = course(c, false);
                    long start = BaseScheduleWidget.hmOrMin(c.optString("start", ""));
                    long end = c.optString("end", "").matches("\\d{1,2}:\\d{2}")
                            ? BaseScheduleWidget.hmOrMin(c.optString("end", ""))
                            : BaseScheduleWidget.startOfToday() + 86400000L;
                    r.ongoing = start != Long.MIN_VALUE && start <= now && now < end;
                    if (!sawUpcoming && start != Long.MIN_VALUE && start > now) {
                        sawUpcoming = true;   // 第一门还没上的课 = 下一节（时间列加品牌色）
                    }
                    rows.add(r);
                }
            }

            if (rows.isEmpty()) {
                /* 今天 0 节课：与其留白，把明天亮出来（跨周时快照里没有明天，就只有提示行） */
                String tomorrowISO = new SimpleDateFormat("yyyy-MM-dd", Locale.US)
                        .format(new Date(BaseScheduleWidget.startOfToday() + 86400000L));
                JSONObject tDay = BaseScheduleWidget.dayInSnapshot(snap, tomorrowISO);
                JSONArray tCourses = tDay == null ? null : tDay.optJSONArray("courses");
                boolean hasTomorrow = tCourses != null && tCourses.length() > 0;
                rows.add(note(hasTomorrow ? "今天没有课 · 明天有安排：" : "今天没有课"));
                if (hasTomorrow) {
                    for (int i = 0; i < tCourses.length(); i++) {
                        JSONObject c = tCourses.optJSONObject(i);
                        if (c != null) rows.add(course(c, true));
                    }
                }
            }
        }

        /** 快照课程 → 行（tomorrow=true 时整行置灰、时间列首行显示"明天"） */
        private Row course(JSONObject c, boolean tomorrow) {
            Row r = new Row();
            r.type = TYPE_COURSE;
            r.tomorrow = tomorrow;
            r.color = c.optString("color", "");
            r.name = c.optString("name", "");
            String loc = c.optString("location", "");
            String teacher = c.optString("teacher", "");
            if (loc.isEmpty() && teacher.isEmpty()) {
                r.place = "";
            } else if (loc.isEmpty()) {
                r.place = teacher;
            } else if (teacher.isEmpty()) {
                r.place = loc;
            } else {
                r.place = loc + " · " + teacher;
            }
            r.tStart = c.optString("start", "");
            r.tEnd = c.optString("end", "");
            return r;
        }

        private Row note(String text) {
            Row r = new Row();
            r.type = TYPE_NOTE;
            r.note = text;
            return r;
        }

        @Override
        public RemoteViews getViewAt(int position) {
            Row r = rows.get(position);
            if (r.type == TYPE_NOTE) {
                RemoteViews rv = new RemoteViews(ctx.getPackageName(), R.layout.widget_item_note);
                rv.setTextViewText(R.id.item_note, r.note);
                rv.setOnClickFillInIntent(R.id.item_note, new Intent());
                return rv;
            }

            RemoteViews rv = new RemoteViews(ctx.getPackageName(), compact
                    ? R.layout.widget_item_course_compact
                    : R.layout.widget_item_course);
            int accent = ctx.getColor(R.color.widget_accent);
            int onSurface = ctx.getColor(R.color.widget_on_surface);
            int secondary = ctx.getColor(R.color.widget_secondary);
            /* 明天预览整行降一档亮度：名字用次级色（仍可读），与今天的课程一眼区分 */
            int nameColor = r.tomorrow ? secondary : onSurface;
            int timeColor = r.tomorrow ? secondary : onSurface;

            rv.setInt(R.id.item_bar, "setBackgroundColor",
                    BaseScheduleWidget.parseColor(r.color, 0xFF109D7F));

            if (compact) {
                /* 单行：08:00 课名 · 教室 */
                rv.setTextViewText(R.id.item_t_start, r.tStart);
                rv.setTextColor(R.id.item_t_start, timeColor);
                rv.setTextViewText(R.id.item_name, r.name);
                rv.setTextColor(R.id.item_name, nameColor);
                rv.setTextViewText(R.id.item_place, r.place);
                rv.setTextColor(R.id.item_place, secondary);
            } else {
                /* 两行：时间列（开始/—结束）+ 课名与教室·教师 */
                if (r.ongoing) {
                    rv.setTextViewText(R.id.item_t_start, "现在");
                    rv.setTextColor(R.id.item_t_start, accent);
                } else {
                    rv.setTextViewText(R.id.item_t_start, r.tStart);
                    rv.setTextColor(R.id.item_t_start, timeColor);
                }
                rv.setTextViewText(R.id.item_t_end, r.tEnd.isEmpty() ? "" : "-" + r.tEnd);
                rv.setTextColor(R.id.item_t_end, secondary);
                rv.setTextViewText(R.id.item_name, r.name);
                rv.setTextColor(R.id.item_name, nameColor);
                rv.setTextViewText(R.id.item_place, r.place);
                rv.setTextColor(R.id.item_place, secondary);
            }
            rv.setOnClickFillInIntent(R.id.item_root, new Intent());
            return rv;
        }

        @Override
        public int getViewTypeCount() {
            return 2;
        }

        @Override
        public int getCount() {
            return rows.size();
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public boolean hasStableIds() {
            return false;
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;   // 用默认加载态
        }

        @Override
        public void onDestroy() {
            rows.clear();
        }
    }
}
