"""Short, read-only host health context built from the SysAgent local query API cache."""

import re

from . import local_api

_CONTROL = re.compile(r'[\x00-\x1f\x7f\u2028\u2029]+')
MAX_CHARS = 600


def _text(value, limit=40):
    if not isinstance(value, str):
        return ''
    value = _CONTROL.sub(' ', value).strip()
    return value[:limit]


def _count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def render_summary(response):
    """Render the /api/v1/summary envelope; None when it carries no usable evidence."""
    data = response.get('data')
    meta = response.get('meta') if isinstance(response.get('meta'), dict) else {}
    if not isinstance(data, dict):
        return None
    band = data.get('band') if isinstance(data.get('band'), dict) else {}
    score = data.get('score')
    score = score if isinstance(score, (int, float)) and not isinstance(score, bool) else None
    checked, total, unavailable = _count(data.get('checked')), _count(data.get('total')), _count(data.get('unavailable'))
    sampled = _text(meta.get('sampled_at'), 32) or '未知时间'
    parts = ['SysAgent管家本机缓存（采样 %s，可能已过期）' % sampled]
    status = _text(band.get('label'))
    if status or score is not None:
        parts.append('：%s%s' % (status, '，评分 %d' % round(score) if score is not None else ''))
    if checked is not None and total is not None:
        parts.append('；已检查巡检 %d/%d 项' % (checked, total))
    if unavailable is not None:
        parts.append('，资源不可用 %d 项' % unavailable)
    open_items = data.get('open') if isinstance(data.get('open'), list) else []
    labels = [_text(item.get('label')) for item in open_items[:5] if isinstance(item, dict)]
    labels = [item for item in labels if item]
    if labels:
        parts.append('。待关注：%s%s' % ('、'.join(labels), ' 等 %d 项' % len(open_items) if len(open_items) > len(labels) else ''))
    parts.append('。仅为只读缓存摘要，未知项不代表正常；需要最新状态请在管家界面重新获取。')
    return ''.join(parts)[:MAX_CHARS]


def local_health_context(env=None, timeout=0.4):
    for endpoint in local_api.endpoints(env)[:3]:
        try:
            text = render_summary(local_api.get(endpoint, '/api/v1/summary', timeout=timeout))
        except Exception:
            continue
        if text:
            return text
    return None
