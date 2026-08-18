// migration.js — перенос АКТУАЛЬНЫХ записей клиентов на занятия из MongoDB 'pole_dance'
// в сделки Битрикс24.
//
// Запуск: node migration.js
//
// ⚠️ ПЕРВЫЙ ЗАПУСК ВСЕГДА С DRY_RUN = true (см. флаг ниже) — скрипт только выведет
// в консоль, что будет отправлено, и НЕ создаст ни одной сделки в Битриксе.
// Внимательно проверьте вывод (особенно ⚠️-предупреждения о пропущенных записях —
// в них обычно видно, что поля в реальных документах называются не так, как я предположил)
// и только после этого переключите DRY_RUN на false.

import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { createBookingDeal } from './bitrix.js';

// ⚠️ Этот скрипт написан под старую схему студии танцев (classes/directions).
// После перехода на общую концепцию "встречи" он нужен только для одноразового
// переноса старых записей и, скорее всего, вам не понадобится для новых данных —
// но раз он ходит в bitrix.js, привёл его в соответствие с новой сигнатурой
// (topic + Date-объекты вместо direction + ISO-строк).

const DRY_RUN = true; // <-- переключить на false только после проверки вывода

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'pole_dance';

// Откуда брать записи:
//  'classBookings' — реальные занятые слоты (classId+chatId), имя/телефон подтягиваются
//                    из коллекции bookings (профиль пользователя, unique по chatId).
//  'applications'  — заявки, в которых имя/телефон/направление уже лежат прямо в документе
//                    (используйте, если в bookings нет имени/телефона, или нужны
//                    подтверждённые заявки, а не разовые слоты).
const SOURCE = process.env.MIGRATION_SOURCE || 'classBookings';

const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// classes хранят занятия без конкретной даты, только день недели (mon/tue/...) — берём
// ближайшее будущее вхождение этого дня недели как BEGINDATE сделки.
function nextOccurrence(dayKey, timeStr) {
  const targetDow = WEEKDAY_INDEX[dayKey];
  if (targetDow === undefined) return null;
  const [h, m] = String(timeStr || '00:00').split(':').map(Number);
  const now = new Date();
  const result = new Date(now);
  const diff = (targetDow - now.getDay() + 7) % 7;
  result.setDate(now.getDate() + diff);
  result.setHours(h || 0, m || 0, 0, 0);
  if (result < now) result.setDate(result.getDate() + 7);
  return result;
}

function resolveDirectionName(rawDirection, directionsById) {
  if (!rawDirection) return 'Не указано';
  const asId = String(rawDirection);
  if (directionsById.has(asId)) return directionsById.get(asId);
  return String(rawDirection); // уже строка-название
}

async function migrateFromClassBookings(db) {
  const classBookings = await db.collection('classBookings').find({}).toArray();
  console.log(`Найдено ${classBookings.length} записей в classBookings`);

  const classes = await db.collection('classes')
    .find({ _id: { $in: classBookings.map(b => b.classId) } }).toArray();
  const classesById = new Map(classes.map(c => [String(c._id), c]));

  const chatIds = [...new Set(classBookings.map(b => b.chatId))];
  const profiles = await db.collection('bookings').find({ chatId: { $in: chatIds } }).toArray();
  const profilesByChatId = new Map(profiles.map(p => [p.chatId, p]));

  const directions = await db.collection('directions').find({}).toArray();
  const directionsById = new Map(directions.map(d => [String(d._id), d.name]));

  const rows = [];
  for (const cb of classBookings) {
    const cls = classesById.get(String(cb.classId));
    if (!cls) {
      console.warn(`⚠️  classBookings/${cb._id}: не найдено занятие classId=${cb.classId} — пропуск`);
      continue;
    }

    const profile = profilesByChatId.get(cb.chatId);
    if (!profile || !profile.name || !profile.phone) {
      console.warn(
        `⚠️  classBookings/${cb._id}: в bookings нет имени/телефона для chatId=${cb.chatId} ` +
        `(найден профиль: ${JSON.stringify(profile || null)}) — пропуск. ` +
        `Если поля называются иначе — поправьте mapProfile ниже.`
      );
      continue;
    }

    const fromDate = nextOccurrence(cls.day, cls.time);
    if (!fromDate) {
      console.warn(`⚠️  classBookings/${cb._id}: непонятный день недели "${cls.day}" — пропуск`);
      continue;
    }
    const toDate = new Date(fromDate.getTime() + 60 * 60 * 1000);

    rows.push({
      sourceId: cb._id,
      name: profile.name,
      phone: profile.phone,
      topic: resolveDirectionName(cls.direction, directionsById),
      fromDate,
      toDate,
      chatId: cb.chatId,
      username: profile.username,
    });
  }
  return rows;
}

async function migrateFromApplications(db) {
  // Подстройте фильтр под нужный статус (напр. только подтверждённые заявки)
  const statusFilter = process.env.APPLICATIONS_STATUS
    ? { status: process.env.APPLICATIONS_STATUS }
    : {};
  const applications = await db.collection('applications').find(statusFilter).toArray();
  console.log(`Найдено ${applications.length} заявок в applications${process.env.APPLICATIONS_STATUS ? ` (status=${process.env.APPLICATIONS_STATUS})` : ''}`);

  const classIds = applications.map(a => a.confirmedClassId).filter(Boolean);
  const classes = classIds.length
    ? await db.collection('classes').find({ _id: { $in: classIds } }).toArray()
    : [];
  const classesById = new Map(classes.map(c => [String(c._id), c]));

  const rows = [];
  for (const app of applications) {
    if (!app.name || !app.phone) {
      console.warn(`⚠️  applications/${app._id}: нет имени/телефона в самой заявке (${JSON.stringify({ name: app.name, phone: app.phone })}) — пропуск`);
      continue;
    }

    let fromDate = null;
    const cls = app.confirmedClassId ? classesById.get(String(app.confirmedClassId)) : null;
    if (cls) fromDate = nextOccurrence(cls.day, cls.time);
    if (!fromDate) fromDate = new Date(); // заявка ещё не привязана к конкретному занятию

    const toDate = new Date(fromDate.getTime() + 60 * 60 * 1000);

    rows.push({
      sourceId: app._id,
      name: app.name,
      phone: app.phone,
      topic: app.direction || 'Не указано',
      fromDate,
      toDate,
      chatId: app.chatId,
      username: app.username,
    });
  }
  return rows;
}

async function main() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI не задан');

  console.log(DRY_RUN
    ? '🔒 DRY_RUN=true — сделки создаваться НЕ будут, только вывод в консоль.\n'
    : '🚀 DRY_RUN=false — сделки будут реально создаваться в Битриксе!\n');
  console.log(`Источник: ${SOURCE}\n`);

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  const rows = SOURCE === 'applications'
    ? await migrateFromApplications(db)
    : await migrateFromClassBookings(db);

  console.log(`\nК переносу готово: ${rows.length} записей.\n`);

  let ok = 0, failed = 0;
  for (const row of rows) {
    const { sourceId, ...dealInput } = row;
    if (DRY_RUN) {
      console.log(`would create deal for ${sourceId}:`, dealInput);
      ok++;
      continue;
    }
    try {
      const dealId = await createBookingDeal(dealInput);
      console.log(`✅ ${sourceId} -> сделка #${dealId}`);
      ok++;
    } catch (err) {
      console.error(`❌ ${sourceId}:`, err.message);
      failed++;
    }
    await sleep(150); // мягкая защита от лимитов Битрикса
  }

  console.log(`\nГотово. Успешно: ${ok}, с ошибкой: ${failed}.`);
  await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
