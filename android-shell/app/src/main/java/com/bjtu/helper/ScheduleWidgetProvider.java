package com.bjtu.helper;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

import org.json.JSONObject;

/**
 * 桌面小组件 · 完整版（默认 4×3，可自由缩放）。
 *
 * 布局：顶栏（品牌 + 日期/周次）+ 课程列表（ListView，weight=1 吃满剩余高度，
 * 两行式课程行，可滚动）+ 沉底的最近 DDL 行。
 *
 * ⚠️ 类名与 receiver 组件名**不能改**：用户桌面上已添加的实例绑定的是这个
 * ComponentName，改名等于把他们桌面上的组件全部变成"无法更新"的死块。
 * 4×2 / 2×2 尺寸请新增 provider（见 ScheduleWidgetMediumProvider / ScheduleWidgetSmallProvider）。
 *
 * 课程列表由 {@link ScheduleWidgetListService} 供数（MODE_FULL：两行式课程行，
 * 今天没课时附上明天预览，快照过期时给引导文案）。
 */
public class ScheduleWidgetProvider extends BaseScheduleWidget {

    @Override
    ComponentName componentName(Context context) {
        return new ComponentName(context, ScheduleWidgetProvider.class);
    }

    @Override
    int listViewId() {
        return R.id.course_list;
    }

    @Override
    RemoteViews build(Context context, int appWidgetId) {
        RemoteViews rv = new RemoteViews(context.getPackageName(), R.layout.widget_schedule);
        JSONObject snap = WidgetDataStore.load(context);

        rv.setTextViewText(R.id.widget_title, context.getString(R.string.app_name));
        rv.setTextViewText(R.id.widget_date, todayLabel() + weekLabel(snap));

        /* 课程列表：适配器带 EXTRA_MODE，服务按模式渲染两行式/紧凑行 */
        Intent svc = new Intent(context, ScheduleWidgetListService.class)
                .putExtra(ScheduleWidgetListService.EXTRA_MODE, ScheduleWidgetListService.MODE_FULL);
        rv.setRemoteAdapter(appWidgetId, R.id.course_list, svc);
        /* 列表行的点击也交给"打开 App"：PendingIntentTemplate + 行内 FillInIntent */
        rv.setPendingIntentTemplate(R.id.course_list, openAppIntent(context));

        renderDdlFooter(context, rv, snap);
        rv.setOnClickPendingIntent(R.id.widget_root, openAppIntent(context));
        return rv;
    }
}
