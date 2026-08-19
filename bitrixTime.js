// bitrixTime.js — все преобразования дат между "настенным" временем организации
// (ORG_TIMEZONE) и форматами, которые понимает Битрикс24.
//
// Главное правило №1: Битрикс должен получать от нас строку с ЯВНЫМ смещением
// зоны (например "2026-08-18T06:00:00+03:00"), а не UTC с "Z". Раньше код слал
// toISOString() (UTC), и Битрикс трактовал эти цифры как локальное время
// портала без пересчёта — отсюда сдвиг времени, который был на скрине (03:00
// вместо реального времени встречи).
//
// Главное правило №2: то, что Битрикс возвращает нам обратно (calendar.event.get),
// НЕЛЬЗЯ парсить через `new Date(строка)` — он отдаёт даты в своём формате
// "ДД.ММ.ГГГГ ЧЧ:ММ:СС", который Node.js не понимает и превращает в Invalid Date.
// Из-за этого проверка занятости слота молча всегда возвращала "свободно".

export function pad2(n) { return String(n).padStart(2, '0'); }

// Смещение (в мс) заданной таймзоны относительно UTC в момент времени `date`.
// Положительное значение — зона восточнее UTC (Europe/Minsk = +3ч = 10800000 мс).
export function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  dtf.formatToParts(date).forEach(p => { if (p.type !== 'literal') map[p.type] = p.value; });
  const asUTC = Date.UTC(map.year, map.month - 1, map.day, map.hour === '24' ? 0 : map.hour, map.minute, map.second);
  return asUTC - date.getTime();
}

// "Настенное" время (дата + часы:минуты ПО ВРЕМЕНИ ОРГАНИЗАЦИИ) -> правильный момент в UTC.
export function zonedTimeToUTC(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
  const offset = tzOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

export function hhmmInTZ(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function nowInTZ(timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit',
    year: 'numeric', month: '2-digit', day: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return { time: `${map.hour}:${map.minute}`, dateStr: `${map.year}-${map.month}-${map.day}` };
}

// "Якорная" дата (полночь UTC того же Y-M-D) из строки "YYYY-MM-DD" — используется
// исключительно для перебора дней (день+1, день+2, ...), не как реальный момент времени.
export function dateStrToAnchor(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d));
}

// Понедельник текущей недели по календарю организации — только "якоря" дат
// (полночь UTC того же Y-M-D, используется исключительно для перебора дней недели).
export function currentWeekRange(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { if (p.type !== 'literal') map[p.type] = p.value; });

  const anchor = new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)));
  const dow = anchor.getUTCDay() === 0 ? 7 : anchor.getUTCDay(); // пн=1..вс=7
  const monday = new Date(anchor);
  monday.setUTCDate(anchor.getUTCDate() - (dow - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { monday, sunday };
}

export function overlaps(aFrom, aTo, bFrom, bTo) {
  return aFrom < bTo && bFrom < aTo;
}

function formatOffset(ms) {
  const sign = ms >= 0 ? '+' : '-';
  const abs = Math.abs(ms);
  const hh = Math.floor(abs / 3600000);
  const mm = Math.floor((abs % 3600000) / 60000);
  return `${sign}${pad2(hh)}:${pad2(mm)}`;
}

// ФИКС бага "время уезжает": строка с явным смещением зоны организации.
// Именно её нужно слать в BEGINDATE/CLOSEDATE сделки и в calendar.event.add —
// никогда toISOString() (UTC/"Z").
export function toBitrixISO(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const map = {};
  dtf.formatToParts(date).forEach(p => { if (p.type !== 'literal') map[p.type] = p.value; });
  const offsetMs = tzOffsetMs(date, timeZone);
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}${formatOffset(offsetMs)}`;
}

// ФИКС бага "календарь не блокирует занятое время": парсим то, что реально
// присылает Битрикс (ISO ИЛИ его классический "ДД.ММ.ГГГГ ЧЧ:ММ[:СС]"),
// вместо того чтобы вслепую доверять `new Date(строка)`.
export function parseBitrixDateTime(str, timeZone) {
  if (!str) return null;

  // Уже ISO (с "Z" или смещением) — доверяем как есть.
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Классический формат Битрикса: "ДД.ММ.ГГГГ[ ЧЧ:ММ[:СС]]"
  const m = /^(\d{2})\.(\d{2})\.(\d{4})(?:[ T](\d{2}):(\d{2}))?/.exec(str);
  if (!m) return null;
  const [, dd, mo, yyyy, hh = '00', mi = '00'] = m;
  return zonedTimeToUTC(`${yyyy}-${mo}-${dd}`, `${hh}:${mi}`, timeZone);
}
