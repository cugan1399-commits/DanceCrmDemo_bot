// bitrix.js — тонкая обёртка над входящим вебхуком Битрикс24.
// Всё общение с Битриксом идёт через один REST endpoint вида:
//   https://ваш-портал.bitrix24.ru/rest/1/xxxxxxxxxxxxxxxx/
// (входящий вебхук создаётся в Битриксе: Разработчикам -> Другое -> Входящий вебхук,
//  с правами на CRM и Календарь)

import axios from 'axios';
import { toBitrixISO, parseBitrixDateTime } from './bitrixTime.js';

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const BITRIX_CALENDAR_ID = process.env.BITRIX_CALENDAR_ID || '1';
// 'user' — календарь конкретного сотрудника (ownerId = его ID в Битриксе).
// Если ведёте общий календарь через календарь группы/отдела — поставьте 'group'.
const BITRIX_CALENDAR_TYPE = process.env.BITRIX_CALENDAR_TYPE || 'user';
const BITRIX_TG_FIELD_NAME = process.env.BITRIX_TG_FIELD_NAME; // напр. UF_CRM_1786993488929
const ORG_TIMEZONE = process.env.ORG_TIMEZONE || 'Europe/Minsk';

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

// Возвращает занятые интервалы на диапазон [fromDate, toDate] как Date-объекты.
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
    .map(e => ({
      id: e.ID,
      name: e.NAME,
      from: parseBitrixDateTime(e.DATE_FROM, ORG_TIMEZONE),
      to: parseBitrixDateTime(e.DATE_TO, ORG_TIMEZONE),
    }))
    // если формат даты внезапно оказался незнакомым — выкидываем событие,
    // а не тихо считаем слот свободным (как было раньше с Invalid Date)
    .filter(e => e.from instanceof Date && e.to instanceof Date && !Number.isNaN(e.from.getTime()) && !Number.isNaN(e.to.getTime()));
}

// Ставит "занято" в календаре Битрикса на конкретный слот (чтобы не было двойной записи,
// пока сделка ещё не подтверждена администратором). Принимает Date-объекты, а не готовые
// строки — время в Битрикс уходит с явным смещением зоны организации (см. bitrixTime.js).
export async function blockCalendarSlot({ fromDate, toDate, title }) {
  return bitrixCall('calendar.event.add', {
    type: BITRIX_CALENDAR_TYPE,
    ownerId: BITRIX_CALENDAR_ID,
    name: title,
    from: toBitrixISO(fromDate, ORG_TIMEZONE),
    to: toBitrixISO(toDate, ORG_TIMEZONE),
  });
}

export async function removeCalendarEvent(eventId) {
  if (!eventId) return;
  return bitrixCall('calendar.event.delete', { id: eventId });
}

// ---------- CRM: сделки ----------

function humanTime(date) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: ORG_TIMEZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

// Время теперь ВСЕГДА в заголовке сделки — раньше его там не было, и все отменённые
// клиентом заявки в CRM выглядели одинаково и неотличимо друг от друга.
function dealFields({ name, phone, topic, fromDate, toDate, chatId, username }) {
  const fields = {
    TITLE: `Встреча ${humanTime(fromDate)} — ${name}`,
    BEGINDATE: toBitrixISO(fromDate, ORG_TIMEZONE),
    CLOSEDATE: toBitrixISO(toDate, ORG_TIMEZONE),
    COMMENTS: [
      `Тема встречи: ${topic}`,
      `Телефон: ${phone}`,
      username ? `Telegram: @${username}` : null,
    ].filter(Boolean).join('\n'),
  };
  if (BITRIX_TG_FIELD_NAME) fields[BITRIX_TG_FIELD_NAME] = String(chatId);
  return fields;
}

export async function createBookingDeal(input) {
  return bitrixCall('crm.deal.add', { fields: dealFields(input) });
}

// Используется при повторной записи того же клиента (после переноса времени):
// та же самая сделка переезжает на новое время и возвращается на стадию, где
// начинается подтверждение — вместо того чтобы плодить рядом новую сделку-копию.
export async function updateBookingDeal(dealId, input, stageId) {
  const fields = dealFields(input);
  if (stageId) fields.STAGE_ID = stageId;
  return bitrixCall('crm.deal.update', { id: dealId, fields });
}

export function getDeal(dealId) {
  return bitrixCall('crm.deal.get', { id: dealId });
}

export function updateDealStage(dealId, stageId) {
  return bitrixCall('crm.deal.update', { id: dealId, fields: { STAGE_ID: stageId } });
}

export { BITRIX_TG_FIELD_NAME, BITRIX_CALENDAR_ID, BITRIX_CALENDAR_TYPE, ORG_TIMEZONE };
