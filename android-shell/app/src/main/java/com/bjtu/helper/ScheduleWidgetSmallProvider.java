package com.bjtu.helper;

import android.content.ComponentName;
import android.content.Context;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONObject;

/**
 * 桌面小组件 · 紧凑版（2×2）。
 *
 * 没有课程列表：只显示「正在上 / 下一节」（今天没课回退明天首节）+ 最近 DDL 倒计时，
 * 四行内容正好铺满 2×2 —— 小尺寸要的是"瞥一眼就知道接下来干嘛"，不是全景。
 * 数据口径与另外两个尺寸完全一致（同一份快照、同一个倒计时算法，见基类）。
 */
public class ScheduleWidgetSmallProvider extends BaseScheduleWidget {

    @Override
    ComponentName componentName(Context context) {
        return new ComponentName(context, ScheduleWidgetSmallProvider.class);
    }

    @Override
    int listViewId() {
        return 0;   // 无列表
    }

    @Override
    RemoteViews build(Context context, int appWidgetId) {
        RemoteViews rv = new RemoteViews(context.getPackageName(), R.layout.widget_small);
        JSONObject snap = WidgetDataStore.load(context);

        rv.setTextViewText(R.id.widget_title, context.getString(R.string.app_name));
        rv.setTextViewText(R.id.widget_date, todayLabel());

        NextCourse nc = nextCourse(snap);
        if (nc == null) {
            /* 快照里今天与明天都没有课（或快照为空）：给一句可操作的话而不是留白 */
            rv.setViewVisibility(R.id.small_course_block, View.GONE);
            rv.setViewVisibility(R.id.small_empty, View.VISIBLE);
            rv.setTextViewText(R.id.small_empty,
                    snap == null ? "打开 App，同步课程与 DDL" : "今天没有课");
        } else {
            rv.setViewVisibility(R.id.small_course_block, View.VISIBLE);
            rv.setViewVisibility(R.id.small_empty, View.GONE);
            rv.setTextViewText(R.id.small_label, nc.label);
            rv.setTextColor(R.id.small_label, context.getColor(
                    nc.ongoing ? R.color.widget_accent : R.color.widget_secondary));
            rv.setTextViewText(R.id.small_name, nc.name);
            rv.setTextViewText(R.id.small_place, nc.place);
            rv.setViewVisibility(R.id.small_place, nc.place.isEmpty() ? View.GONE : View.VISIBLE);
        }

        renderDdlFooter(context, rv, snap);
        rv.setOnClickPendingIntent(R.id.widget_root, openAppIntent(context));
        return rv;
    }
}
