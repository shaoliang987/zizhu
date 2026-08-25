/** Display helpers — Asia/Hong_Kong (HKT, UTC+8). Storage stays ISO/UTC. */
const TZ = process.env.DISPLAY_TZ || 'Asia/Hong_Kong';

function formatHkt(input = new Date(), { withSeconds = true, withLabel = false } = {}) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input || '');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  const base = withSeconds
    ? `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
    : `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  return withLabel ? `${base} HKT` : base;
}

module.exports = { TZ, formatHkt };
