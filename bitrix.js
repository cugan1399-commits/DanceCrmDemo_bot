// bitrix.js — тонкая обёртка над входящим вебхуком Битрикс24.
// Всё общение с Битриксом идёт через один REST endpoint вида:
//   https://ваш-портал.bitrix24.ru/rest/1/xxxxxxxxxxxxxxxx/
// (входящий вебхук создаётся в Битриксе: Разработчикам -> Другое -> Входящий вебхук,
//  с правами на CRM и Календарь)

import axios from 'axios';

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const BITRIX_CALENDAR_ID = process.env.BITRIX_CALENDAR_ID || '1';
// 'user' — календарь конкретного сотрудника (ownerId = его ID в Битриксе).
// Если ведёте общий календарь студии через календарь группы/отдела — поставьте 'group'.
const BITRIX_CALENDAR_TYPE = process.env.BITRIX_CALENDAR_TYPE || 'user';
const BITRIX_TG_FIELD_NAME = process.env.BITRIX_TG_FIELD_NAME; // напр. UF_CRM_1786993488929

if (!BITRIX_WEBHOOK_URL) {
  console.warn('⚠️  BITRIX_WEBHOOK_URL не задан в .env — обращения к Битриксу будут падать');
}
if (!BITRIX_TG_FIELD_NAME) {
  console.warn('⚠️  BITRIX_TG_FIELD_NAME не задан в .env — Telegram ID не будет сохраняться в сделке');
}

function methodUrl(method) {
  return `${BITRIX_WEBHOOK_URL.replace(/\/$/, '')}/${method}.json`;
}

export async function bitrixCall(method, params = {}) {
  const { data } = await axios.post(methodUrl(method), params);
  if (data.error) {
    const err = new Error(`Bitrix24 ${method}: ${data.error_description || data.error}`);
    err.bitrix = data;
    throw err;
  }
  return data.result;
}

// ---------- Календарь: свободное/занятое время ----------

// Возвращает занятые интервалы (Date-объекты) на диапазон [fromDate, toDate]
export async function getBusyRanges(fromDate, toDate) {
  const fmt = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  };

  const events = await bitrixCall('calendar.event.get', {
    type: BITRIX_CALENDAR_TYPE,
    ownerId: BITRIX_CALENDAR_ID,
    from: fmt(fromDate),
    to: fmt(toDate),
  });

  return (events || [])
    .filter(e => e.DATE_FROM && e.DATE_TO)
    .map(e => ({ from: new Date(e.DATE_FROM), to: new Date(e.DATE_TO), name: e.NAME }));
}

// Ставит "занято" в календаре Битрикса на конкретный слот (чтобы не было двойной записи,
// пока сделка ещё не подтверждена администратором)
export async function blockCalendarSlot({ fromISO, toISO, title }) {
  return bitrixCall('calendar.event.add', {
    type: BITRIX_CALENDAR_TYPE,
    ownerId: BITRIX_CALENDAR_ID,
    name: title,
    from: fromISO,
    to: toISO,
  });
}

export async function removeCalendarEvent(eventId) {
  return bitrixCall('calendar.event.delete', { id: eventId });
}

// ---------- CRM: сделки ----------

export async function createBookingDeal({ name, phone, direction, fromISO, toISO, chatId, username }) {
  const fields = {
    TITLE: `Запись: ${direction} — ${name}`,
    BEGINDATE: fromISO,
    CLOSEDATE: toISO,
    COMMENTS: [
      `Направление: ${direction}`,
      `Телефон: ${phone}`,
      username ? `Telegram: @${username}` : null,
    ].filter(Boolean).join('\n'),
  };
  if (BITRIX_TG_FIELD_NAME) fields[BITRIX_TG_FIELD_NAME] = String(chatId);

  return bitrixCall('crm.deal.add', { fields });
}

export function getDeal(dealId) {
  return bitrixCall('crm.deal.get', { id: dealId });
}

export function updateDealStage(dealId, stageId) {
  return bitrixCall('crm.deal.update', { id: dealId, fields: { STAGE_ID: stageId } });
}

export { BITRIX_TG_FIELD_NAME, BITRIX_CALENDAR_ID, BITRIX_CALENDAR_TYPE };
