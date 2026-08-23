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
// Поле в сделке "Ответ клиенту в Телеграм" — менеджер печатает сюда текст прямо в
// карточке сделки, а бот его подхватывает (см. pollManagerReplies в index.js) и
// шлёт клиенту в Telegram. Код поля НЕ совпадает с тем, что написано на форме —
// его нужно посмотреть в ответе crm.deal.fields.json (см. .env.example).
const BITRIX_MANAGER_REPLY_FIELD_NAME = process.env.BITRIX_MANAGER_REPLY_FIELD_NAME;
// Поле НА КОНТАКТЕ (не на сделке!) для Telegram chatId — по нему находим/создаём
// единую "карточку клиента", к которой привязываются ВСЕ его сделки (запись на
// встречу, интерес к товару, эскалация к менеджеру). Код поля свой для контактов,
// он НЕ совпадает с BITRIX_TG_FIELD_NAME сделки, даже если подписи одинаковые —
// смотреть в crm.contact.fields.json, а не в crm.deal.fields.json.
const BITRIX_CONTACT_TG_FIELD_NAME = process.env.BITRIX_CONTACT_TG_FIELD_NAME;
const ORG_TIMEZONE = process.env.ORG_TIMEZONE || 'Europe/Minsk';

// Стадии для сделок ИИ-консультанта (отдельная воронка от встречи — см. dealFields
// выше, там своя логика через BITRIX_*_STAGE_ID). Значения по умолчанию — это
// реальные STATUS_ID из воронки заказчика (см. crm.status.list), но можно
// переопределить через .env, если стадии переименуют/пересоздадут.
const BITRIX_ESCALATION_STAGE_ID = process.env.BITRIX_ESCALATION_STAGE_ID || 'UC_TIVP3I'; // "Требуется вмешательство менеджера"
const BITRIX_ORDER_PAID_ONLINE_STAGE_ID = process.env.BITRIX_ORDER_PAID_ONLINE_STAGE_ID || 'UC_W8J1FY'; // "Оплачено онлайн, ожидает доставку"
const BITRIX_ORDER_COD_STAGE_ID = process.env.BITRIX_ORDER_COD_STAGE_ID || 'UC_J6MCQD'; // "Оплата курьеру при получении, ожидает доставку"

if (!BITRIX_WEBHOOK_URL) {
  console.warn('⚠️  BITRIX_WEBHOOK_URL не задан в .env — обращения к Битриксу будут падать');
}
if (!BITRIX_TG_FIELD_NAME) {
  console.warn('⚠️  BITRIX_TG_FIELD_NAME не задан в .env — Telegram ID не будет сохраняться в сделке');
}
if (!BITRIX_MANAGER_REPLY_FIELD_NAME) {
  console.warn('⚠️  BITRIX_MANAGER_REPLY_FIELD_NAME не задан в .env — ответы менеджера из поля сделки подхватываться не будут');
}
if (!BITRIX_CONTACT_TG_FIELD_NAME) {
  console.warn('⚠️  BITRIX_CONTACT_TG_FIELD_NAME не задан в .env — карточки клиента (контакты) создаваться не будут, все сделки останутся без CONTACT_ID');
}

function methodUrl(method) {
  return `${BITRIX_WEBHOOK_URL.replace(/\/$/, '')}/${method}.json`;
}

// Токен входящего вебхука — та часть URL, что идёт после /rest/{userId}/.
// По ответу поддержки Битрикс24: именно её нужно передавать в параметре auth=
// при скачивании файла по downloadUrl/DOWNLOAD_URL с Диска — тогда Битрикс не
// требует авторизации через браузерную сессию (логин/пароль) и отдаёт файл
// программно. НЕ путать с OAuth access_token — для входящего вебхука он не нужен.
function bitrixWebhookToken() {
  const m = /\/rest\/\d+\/([^/]+)/.exec(BITRIX_WEBHOOK_URL || '');
  return m ? m[1] : null;
}

// Приклеивает ?auth=токен (или &auth=, если в ссылке уже есть свои параметры)
// к ссылке на скачивание файла с Диска.
function withAuthParam(url) {
  const token = bitrixWebhookToken();
  if (!token) {
    console.warn('⚠️  Не удалось извлечь токен вебхука из BITRIX_WEBHOOK_URL — ссылка на фото уйдёт без auth= и может не скачаться');
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}auth=${token}`;
}

export async function bitrixCall(method, params = {}) {
  try {
    const { data } = await axios.post(methodUrl(method), params);
    if (data.error) {
      const err = new Error(`Bitrix24 ${method}: ${data.error_description || data.error}`);
      err.bitrix = data;
      throw err;
    }
    return data.result;
  } catch (err) {
    // ФИКС "Request failed with status code 400" без деталей: когда Bitrix отвечает
    // НЕ 200 (400/401/403/...), axios бросает исключение ДО того, как мы успеваем
    // прочитать data.error/data.error_description — и в логах остаётся только общая
    // фраза от axios, а реальная причина (какое поле не понравилось Bitrix'у) теряется.
    // Здесь достаём тело ответа Bitrix, если оно есть, и кладём его в сообщение и в err.bitrix.
    if (err.response) {
      const body = err.response.data;
      const detail = body?.error_description || body?.error || JSON.stringify(body);
      const wrapped = new Error(`Bitrix24 ${method}: HTTP ${err.response.status} — ${detail}`);
      wrapped.bitrix = body;
      wrapped.httpStatus = err.response.status;
      throw wrapped;
    }
    throw err;
  }
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
function dealFields({ name, phone, topic, fromDate, toDate, chatId, username, contactId }) {
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
  // Привязка к карточке клиента (см. ensureContact в contacts.js) — благодаря ей
  // в Битриксе видно, что "Встреча ..." и, например, "Интерес к товару ..." —
  // сделки ОДНОГО И ТОГО ЖЕ человека, а не два несвязанных обращения.
  if (contactId) fields.CONTACT_ID = contactId;
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

// ---------- Уведомление менеджера (перехват диалога человеком) ----------

// ID сотрудника Битрикс24, который назначается ответственным по сделке-эскалации.
// Найти ID: Компания -> Сотрудники -> открыть карточку -> число в URL. Необязательно —
// без него сделка всё равно создастся, просто без явного ответственного.
const BITRIX_MANAGER_USER_ID = process.env.BITRIX_MANAGER_USER_ID;

// ФИКС "tasks.task.add: HTTP 401 — higher privileges than provided by the webhook
// token": входящий вебхук у вас выдан с правами на CRM и Календарь, а не на Задачи —
// tasks.* требует отдельный scope, которого нет и который не хочется просить
// перевыпускать. Вместо задачи создаём обычную СДЕЛКУ через crm.deal.add — тот же
// метод, что уже используется для записи на встречу, то есть права точно есть.
// Это заодно даёт менеджеру ровно то, что нужно: карточку в CRM с историей диалога
// и Telegram ID клиента, откуда удобно продолжать общение.
export async function notifyManagerAboutEscalation({ chatId, reason, recentHistoryText, contactId }) {
  const fields = {
    TITLE: `⚠️ ИИ передал чат менеджеру (chatId ${chatId})`,
    STAGE_ID: BITRIX_ESCALATION_STAGE_ID,
    COMMENTS: [
      `Причина: ${reason || 'не указана'}`,
      `Telegram chatId: ${chatId}`,
      recentHistoryText ? `\nПоследние сообщения:\n${recentHistoryText}` : null,
    ].filter(Boolean).join('\n'),
  };
  if (BITRIX_MANAGER_USER_ID) fields.ASSIGNED_BY_ID = BITRIX_MANAGER_USER_ID;
  if (BITRIX_TG_FIELD_NAME) fields[BITRIX_TG_FIELD_NAME] = String(chatId);
  if (contactId) fields.CONTACT_ID = contactId;

  return bitrixCall('crm.deal.add', { fields });
}

// Возвращает УЖЕ существующую (ещё не закрытую) сделку-эскалацию обратно в стадию
// "Требуется вмешательство менеджера" — на случай, если менеджер уже успел подвинуть
// её дальше по воронке, а клиент написал ИИ ещё раз и потребовалась новая эскалация
// в ту же сделку (см. escalateToHuman в index.js).
export function moveDealToEscalationStage(dealId) {
  return updateDealStage(dealId, BITRIX_ESCALATION_STAGE_ID);
}

// ---------- Таймлайн сделки: лог того, что клиент спрашивал у ИИ ----------

// Используем crm.timeline.comment.add, а НЕ перезапись поля COMMENTS в самой сделке
// (см. dealFields выше) — так вопросы клиента к ИИ копятся отдельной историей в
// таймлайне сделки (вкладка "История" в карточке), не затирая тему встречи/телефон,
// которые уже занимают COMMENTS.
export async function addDealComment(dealId, text) {
  if (!dealId) return;
  return bitrixCall('crm.timeline.comment.add', {
    fields: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal', COMMENT: text },
  });
}

// Лёгкая сделка "интерес к товару" — создаётся ИИ-консультантом (см. ai.js), когда
// клиент впервые спрашивает про товар, а у него ещё нет "живой" сделки в
// activeBookingByChat. Не дублирует поля встречи (BEGINDATE/CLOSEDATE) — это НЕ
// бронирование, а просто карточка для менеджера, которая позже может либо
// превратиться в сделку встречи (если клиент запишется — см. /api/book), либо
// остаться как есть, если он просто спрашивал.
export async function createInterestDeal({ chatId, username, contactId }) {
  const fields = {
    TITLE: `Интерес к товару — ${username ? '@' + username : `Telegram ${chatId}`}`,
    COMMENTS: username ? `Telegram: @${username}` : `Telegram chatId: ${chatId}`,
  };
  if (BITRIX_TG_FIELD_NAME) fields[BITRIX_TG_FIELD_NAME] = String(chatId);
  if (contactId) fields.CONTACT_ID = contactId;
  return bitrixCall('crm.deal.add', { fields });
}

// "Полноценная" сделка ЗАКАЗА — создаётся ИИ-консультантом ТОЛЬКО когда клиент уже
// подтвердил конкретный товар и сообщил адрес доставки и способ оплаты (см.
// create_order/toolCreateOrder в ai.js). В отличие от createInterestDeal, которая
// просто фиксирует "клиент чем-то интересовался", здесь в COMMENTS сразу лежит всё,
// что нужно менеджеру, чтобы отправить товар: что именно, цвет/размер, куда и как
// оплата. Каждый вызов создаёт НОВУЮ сделку (а не дописывает в старую, как это
// сделано для интереса/эскалации) — заказ это отдельная транзакция каждый раз,
// а не одна и та же "тема" разговора, которую можно продолжать.
// Человекочитаемая подпись способа оплаты в COMMENTS сделки — соответствует двум
// вариантам, которые ИИ может передать (см. create_order в ai.js: параметр
// payment_method — строго 'online' либо 'cash_on_delivery', а не произвольный
// текст, чтобы не гадать по ключевым словам, в какую стадию класть сделку).
const PAYMENT_METHOD_LABELS = {
  online: 'Оплата онлайн',
  cash_on_delivery: 'Оплата курьеру при получении',
};
const STAGE_BY_PAYMENT_METHOD = {
  online: BITRIX_ORDER_PAID_ONLINE_STAGE_ID,
  cash_on_delivery: BITRIX_ORDER_COD_STAGE_ID,
};

export async function createOrderDeal({ chatId, username, contactId, productName, size, color, deliveryAddress, paymentMethod }) {
  const paymentLabel = PAYMENT_METHOD_LABELS[paymentMethod] || paymentMethod;
  const fields = {
    TITLE: `Заказ: ${productName}${color ? ', ' + color : ''}${size ? ', размер ' + size : ''}`,
    COMMENTS: [
      `Товар: ${productName}`,
      color ? `Цвет: ${color}` : null,
      size ? `Размер: ${size}` : null,
      `Адрес доставки: ${deliveryAddress}`,
      `Способ оплаты: ${paymentLabel}`,
      username ? `Telegram: @${username}` : `Telegram chatId: ${chatId}`,
    ].filter(Boolean).join('\n'),
  };
  const stageId = STAGE_BY_PAYMENT_METHOD[paymentMethod];
  if (stageId) fields.STAGE_ID = stageId;
  if (BITRIX_TG_FIELD_NAME) fields[BITRIX_TG_FIELD_NAME] = String(chatId);
  if (contactId) fields.CONTACT_ID = contactId;
  return bitrixCall('crm.deal.add', { fields });
}

// Достаёт РЕАЛЬНОЕ фото товара из коммерческого каталога (а не то, что ИИ мог бы
// найти в интернете и случайно перепутать модель). ФИКС "то один, то другой метод
// возвращает пусто, хотя фото точно есть": пробуем ОБА задокументированных
// способа по очереди, а не полагаемся на один — на этом портале выясняется
// эмпирически, какой из них реально работает.

// Способ 1б: картинка лежит не в стандартных полях previewPicture/detailPicture
// (на этом портале они пустые), а в ПОЛЬЗОВАТЕЛЬСКОМ свойстве товара (propertyNNN,
// код и номер свойства зависят от инфоблока/портала). Такое свойство приходит
// от catalog.product.get как массив вида
// [{ value: { id, url: "/rest/catalog.product.download?fields[...]", urlMachine }, valueId }]
// — то есть в ТОМ ЖЕ формате, что previewPicture/detailPicture, просто под другим
// именем ключа. Ищем по форме значения, а не по конкретному имени свойства, чтобы
// не зависеть от того, что оно называется именно property101 на этом портале.
function findPropertyPictureUrl(product) {
  if (!product) return null;
  for (const key of Object.keys(product)) {
    if (!/^property\d+$/i.test(key)) continue;
    const raw = product[key];
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) {
      const url = item?.value?.url;
      if (typeof url === 'string' && url.includes('catalog.product.download')) return url;
    }
  }
  return null;
}

export async function getProductPhotoUrl(productId) {
  // Способ 1: собственное фото товара через catalog.product.get. Формат ответа —
  // { id, url, urlMachine }, где url — ОТНОСИТЕЛЬНЫЙ путь вида
  // "/rest/catalog.product.download?fields[...]" (нужно достроить хост+токен).
  let productRaw = null;
  try {
    productRaw = await bitrixCall('catalog.product.get', {
      id: productId,
      select: ['id', 'iblockId', 'type', 'previewPicture', 'detailPicture'],
    });
    const product = productRaw?.product || productRaw;
    const picture = product?.detailPicture || product?.previewPicture;
    const rawUrl = picture?.url || findPropertyPictureUrl(product);
    if (rawUrl) {
      const queryIndex = rawUrl.indexOf('?');
      const query = queryIndex >= 0 ? rawUrl.slice(queryIndex) : '';
      const finalUrl = `${BITRIX_WEBHOOK_URL.replace(/\/$/, '')}/catalog.product.download${query}`;
      console.log(`📷 Способ 1 (фото товара #${productId}, поле ${picture?.url ? 'previewPicture/detailPicture' : 'пользовательское property*'}): raw url="${rawUrl}" → итоговая ссылка="${finalUrl}"`);
      return finalUrl;
    }
    console.log(`📷 Способ 1 товара #${productId}: картинки не нашлось ни в previewPicture/detailPicture, ни в property*, сырой ответ:`, JSON.stringify(productRaw));
  } catch (err) {
    console.error(`catalog.product.get для товара #${productId} упал при поиске фото:`, err.message);
  }

  // Способ 2: catalog.productImage.list. ФИКС "downloadUrl оттуда 404-ится": этот
  // downloadUrl — прокси, требующий активную браузерную сессию портала, сервер
  // так скачать не может. Пробуем достать РЕАЛЬНЫЙ ID файла на Диске (fileId) и
  // получить его собственную ссылку через disk.file.get — она рассчитана именно
  // на программный доступ.
  let imagesRaw = null;
  try {
    imagesRaw = await bitrixCall('catalog.productImage.list', {
      productId,
      select: ['id', 'name', 'productId', 'type', 'fileId', 'downloadUrl'],
    });
    const images = imagesRaw?.productImages || imagesRaw || [];
    console.log(`📷 catalog.productImage.list товара #${productId}, сырой ответ:`, JSON.stringify(imagesRaw));
    const preferred =
      images.find(img => img.type === 'DETAIL_PICTURE') ||
      images.find(img => img.type === 'PREVIEW_PICTURE') ||
      images[0];

    if (preferred?.fileId) {
      try {
        const diskRaw = await bitrixCall('disk.file.get', { id: preferred.fileId });
        console.log(`📷 disk.file.get(${preferred.fileId}), сырой ответ:`, JSON.stringify(diskRaw));
        const diskUrl = diskRaw?.DOWNLOAD_URL || diskRaw?.result?.DOWNLOAD_URL;
        if (diskUrl) return withAuthParam(diskUrl);
      } catch (err) {
        console.error(`disk.file.get(${preferred.fileId}) упал:`, err.message);
      }
    }
    if (preferred?.downloadUrl) {
      // НЕ приклеиваем auth= сюда: в отличие от disk.file.get → DOWNLOAD_URL (сырая
      // ссылка Диска), эта ссылка уже самодостаточна — webhook-токен встроен прямо
      // в путь (/rest/{userId}/{webhookToken}/download/), а параметр token= —
      // подпись именно этого запроса (id/name/productId/type). Добавление auth=
      // поверх, судя по всему, ломает эту подпись и вызывает ошибку скачивания.
      console.log(`📷 Способ 2 запасной вариант (productImage.list товара #${productId}): downloadUrl="${preferred.downloadUrl}"`);
      return preferred.downloadUrl;
    }
  } catch (err) {
    console.error(`catalog.productImage.list для товара #${productId} упал при поиске фото:`, err.message);
  }

  // Способ 3: даже когда в UI выбираешь "Простой товар", Битрикс на этом портале
  // всё равно создаёт запись с type=3 ("товар с вариациями") — реальное фото
  // тогда лежит на ДОЧЕРНЕЙ вариации (отдельная запись с parentId=productId).
  // Специальный catalog.product.offer.list для этого каталога заблокирован
  // ("productType is not allowed for this catalog"), но обычный
  // catalog.product.list работает без ограничений — используем его же для
  // поиска дочерней записи по parentId, в обход заблокированного метода.
  try {
    const productForIblock = productRaw?.product || productRaw;
    const iblockId = productForIblock?.iblockId;
    if (iblockId) {
      const childrenRaw = await bitrixCall('catalog.product.list', {
        select: ['id', 'iblockId', 'previewPicture', 'detailPicture'],
        filter: { iblockId, parentId: productId },
      });
      const children = childrenRaw?.products || childrenRaw || [];
      for (const child of children) {
        const childPicture = child?.detailPicture || child?.previewPicture;
        if (childPicture?.url) {
          const queryIndex = childPicture.url.indexOf('?');
          const query = queryIndex >= 0 ? childPicture.url.slice(queryIndex) : '';
          const finalUrl = `${BITRIX_WEBHOOK_URL.replace(/\/$/, '')}/catalog.product.download${query}`;
          console.log(`📷 Способ 3 (вариация товара #${productId}): raw url="${childPicture.url}" → итоговая ссылка="${finalUrl}"`);
          return finalUrl;
        }
      }
    }
  } catch (err) {
    console.error(`Поиск вариации товара #${productId} через catalog.product.list упал:`, err.message);
  }

  // Все три способа не нашли фото — как диагностику ЗАОДНО делаем широкий запрос
  // ВСЕХ вариаций (type=2) в этом инфоблоке (без фильтра по parentId — вдруг
  // формат поля parentId не такой простой, как мы предположили) и печатаем сырой
  // ответ целиком. Так вместо гадания через ручной тестер Битрикса (который явно
  // не принял наш JSON правильно) сразу увидим настоящую структуру данных через
  // уже рабочий код.
  let offersDump = null;
  try {
    const productForIblock = productRaw?.product || productRaw;
    const iblockId = productForIblock?.iblockId;
    if (iblockId) {
      offersDump = await bitrixCall('catalog.product.list', {
        select: ['id', 'iblockId', 'name', 'parentId', 'previewPicture', 'detailPicture', 'type'],
        filter: { iblockId, type: 2 },
      });
    }
  } catch (err) {
    offersDump = { error: err.message };
  }

  console.warn(
    `⚠️  Фото товара #${productId} не найдено ни одним способом. ` +
    `catalog.product.get → ${JSON.stringify(productRaw)}; ` +
    `catalog.productImage.list → ${JSON.stringify(imagesRaw)}; ` +
    `ВСЕ вариации (type=2) в инфоблоке → ${JSON.stringify(offersDump)}`
  );
  return null;
}

// ---------- Ответ менеджера прямо из поля сделки ----------

// Находит сделки, где поле "Ответ клиенту в Телеграм" заполнено (менеджер только
// что написал туда текст). Фильтр '!ПОЛЕ': '' — стандартный для Bitrix24 REST
// способ сказать "поле НЕ равно пустой строке" (аналог != '').
// select включает поле с Telegram ID сделки — запасной способ найти chatId,
// если в своей БД (dealBookingInfo) записи о сделке нет (см. index.js).
export async function getDealsWithManagerReply() {
  if (!BITRIX_MANAGER_REPLY_FIELD_NAME) return [];
  const select = ['ID', BITRIX_MANAGER_REPLY_FIELD_NAME];
  if (BITRIX_TG_FIELD_NAME) select.push(BITRIX_TG_FIELD_NAME);
  return bitrixCall('crm.deal.list', {
    filter: { ['!' + BITRIX_MANAGER_REPLY_FIELD_NAME]: '' },
    select,
  });
}

// Очищаем поле сразу ПОСЛЕ успешной отправки в Telegram (см. pollManagerReplies
// в index.js) — если очистить раньше и отправка упадёт, текст менеджера потеряется;
// если не очищать вовсе — то же сообщение уйдёт клиенту повторно на следующем тике.
export async function clearManagerReplyField(dealId) {
  if (!BITRIX_MANAGER_REPLY_FIELD_NAME) return;
  return bitrixCall('crm.deal.update', {
    id: dealId,
    fields: { [BITRIX_MANAGER_REPLY_FIELD_NAME]: '' },
  });
}

// ---------- CRM: карточка клиента (Contact) ----------
//
// Один Telegram-пользователь = один Contact в Битриксе, независимо от того, с чего
// он начал (запись на встречу или вопрос ИИ про товар). Сами сделки (Deal) как
// создавались отдельно под каждый сценарий, так и создаются — но теперь у каждой
// проставляется CONTACT_ID на этот Contact (см. dealFields/createInterestDeal/
// notifyManagerAboutEscalation выше), и в Битриксе видно ИСТОРИЮ клиента целиком,
// а не набор внешне не связанных карточек. Локальное кеширование chatId->contactId
// (таблица contactByChat) и решение "создавать или переиспользовать" — в contacts.js,
// здесь только сырые REST-вызовы.

export async function findContactByChatId(chatId) {
  if (!BITRIX_CONTACT_TG_FIELD_NAME) return null;
  const result = await bitrixCall('crm.contact.list', {
    filter: { [BITRIX_CONTACT_TG_FIELD_NAME]: String(chatId) },
    select: ['ID'],
  });
  return result && result[0] ? result[0].ID : null;
}

export async function createContact({ chatId, username, name, phone }) {
  const fields = {
    NAME: name || (username ? `@${username}` : `Telegram ${chatId}`),
  };
  if (phone) fields.PHONE = [{ VALUE: phone, VALUE_TYPE: 'WORK' }];
  if (username) fields.WEB = [{ VALUE: `https://t.me/${username}`, VALUE_TYPE: 'WORK' }];
  if (BITRIX_CONTACT_TG_FIELD_NAME) fields[BITRIX_CONTACT_TG_FIELD_NAME] = String(chatId);
  return bitrixCall('crm.contact.add', { fields });
}

// Дозаполняем карточку, когда узнаём то, чего раньше не знали (например, клиент
// сначала просто спрашивал про товар без имени/телефона, а потом записался на
// встречу и указал их) — контакт при этом остаётся тем же самым, не плодим новый.
export async function updateContact(contactId, { name, phone }) {
  const fields = {};
  if (name) fields.NAME = name;
  if (phone) fields.PHONE = [{ VALUE: phone, VALUE_TYPE: 'WORK' }];
  if (!Object.keys(fields).length) return;
  return bitrixCall('crm.contact.update', { id: contactId, fields });
}

export {
  BITRIX_TG_FIELD_NAME,
  BITRIX_MANAGER_REPLY_FIELD_NAME,
  BITRIX_CONTACT_TG_FIELD_NAME,
  BITRIX_CALENDAR_ID,
  BITRIX_CALENDAR_TYPE,
  ORG_TIMEZONE,
};
