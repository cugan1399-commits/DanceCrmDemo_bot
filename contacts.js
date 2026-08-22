// contacts.js — единая точка "найти или создать карточку клиента (CRM Contact)
// по Telegram chatId". Вынесено в отдельный файл (а не в index.js), потому что
// вызывается ИЗ ДВУХ мест: index.js (запись на встречу через /api/book, эскалация
// к менеджеру) и ai.js (первый вопрос клиента про товар) — а ai.js импортирует
// только из bitrix.js, чтобы не создавать циклическую зависимость с index.js.
//
// Идея: какое бы действие клиент ни выбрал первым, у него должна быть РОВНО ОДНА
// карточка клиента в Битриксе, и все его сделки (встреча, интерес к товару,
// эскалация) должны ссылаться на неё через CONTACT_ID — тогда в CRM видно, что
// это один и тот же человек, а не несколько разрозненных обращений.
//
// Локальный кеш (коллекция contactByChat в Mongo) — тот же приём, что уже
// используется для activeBookingByChat/dealBookingInfo: избегаем лишнего похода
// в Битрикс на каждое сообщение и, самое главное, избегаем гонки "два сообщения
// от одного клиента почти одновременно -> два Contact вместо одного", потому что
// после первого успешного создания дальнейшие вызовы используют уже сохранённый ID,
// а не переспрашивают Битрикс.
import { findContactByChatId, createContact, updateContact } from './bitrix.js';

export async function ensureContact({ db, chatId, username, name, phone }) {
  if (!chatId) return null;

  if (db) {
    const cached = await db.collection('contactByChat').findOne({ chatId });
    if (cached?.contactId) {
      // Дозаполняем карточку, если сейчас узнали то, чего раньше не было (имя/телефон
      // обычно появляются позже — при записи на встречу, а не при первом вопросе к ИИ).
      if ((name && name !== cached.name) || (phone && phone !== cached.phone)) {
        try {
          await updateContact(cached.contactId, { name, phone });
        } catch (err) {
          console.error(`Не удалось обновить карточку клиента #${cached.contactId}:`, err.message);
        }
        await db.collection('contactByChat').updateOne(
          { chatId },
          { $set: { name: name || cached.name, phone: phone || cached.phone } },
        );
      }
      return cached.contactId;
    }
  }

  // Ищем в самом Битриксе на случай, если карточка уже создана раньше (например,
  // локальная БД была очищена/недоступна в момент создания) — так не плодим дубли.
  let contactId = null;
  try {
    contactId = await findContactByChatId(chatId);
  } catch (err) {
    console.error('Не удалось проверить существование карточки клиента в Битриксе:', err.message);
  }
  if (!contactId) {
    contactId = await createContact({ chatId, username, name, phone });
  }

  if (db) {
    await db.collection('contactByChat').updateOne(
      { chatId },
      { $set: { chatId, contactId, name: name || null, phone: phone || null } },
      { upsert: true },
    );
  }
  return contactId;
}
