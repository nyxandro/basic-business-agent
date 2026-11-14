// Error codes with their HTTP status and the text for people (spec, section 9).
// The texts already say what to do next, so `nextStep` is set only where it adds something.
import { AppError } from './app-error.ts';

interface CatalogEntry {
  status: number;
  userMessage: string;
  nextStep?: string;
}

export const ERROR_CATALOG = {
  APP_VALIDATION_FAILED: { status: 400, userMessage: 'Данные заполнены неверно. Проверьте поля и попробуйте ещё раз.' },
  APP_NOT_FOUND: { status: 404, userMessage: 'Такой страницы или данных нет.' },
  APP_INTERNAL: { status: 500, userMessage: 'Что-то пошло не так на сервере. Попробуйте ещё раз; если повторяется — сообщите администратору код ошибки.' },
  APP_AUTH_INVALID_CREDENTIALS: { status: 401, userMessage: 'Неверная почта или пароль. Проверьте раскладку и попробуйте ещё раз.' },
  APP_AUTH_RATE_LIMITED: { status: 429, userMessage: 'Слишком много попыток входа. Подождите несколько минут и попробуйте снова.' },
  APP_AUTH_BANNED: { status: 403, userMessage: 'Ваша учётная запись заблокирована. Обратитесь к администратору.' },
  APP_AUTH_SESSION_EXPIRED: { status: 401, userMessage: 'Сессия истекла. Войдите заново — разговоры сохранены.' },
  APP_PASSWORD_TOO_SHORT: { status: 400, userMessage: 'Пароль слишком короткий: нужно не меньше 10 символов.' },
  APP_INVITE_INVALID: { status: 410, userMessage: 'Ссылка-приглашение недействительна или уже использована. Попросите администратора прислать новую.' },
  APP_INVITE_EMAIL_EXISTS: {
    status: 409,
    userMessage: 'Сотрудник с этой почтой уже есть. Если он заблокирован — разблокируйте его, если забыл пароль — создайте ссылку для сброса.',
  },
  APP_PASSWORD_RESET_INVALID: { status: 410, userMessage: 'Ссылка для смены пароля недействительна или устарела. Попросите администратора создать новую.' },
  APP_ADMIN_FORBIDDEN: { status: 403, userMessage: 'Этот раздел вам недоступен. Если он нужен для работы, обратитесь к администратору.' },
  APP_ADMIN_SAVE_FAILED: { status: 500, userMessage: 'Не удалось сохранить изменения. Попробуйте ещё раз; если повторяется — сообщите код ошибки.' },
  APP_ADMIN_LAST_SUPERADMIN: {
    status: 409,
    userMessage: 'Нельзя снять эту роль с последнего суперадминистратора — иначе управлять системой станет некому.',
  },
  APP_ADMIN_BUILTIN_ROLE: { status: 409, userMessage: 'Встроенную роль нельзя удалить или переименовать, а права суперадминистратора — сузить.' },
  APP_ADMIN_NAME_TAKEN: { status: 409, userMessage: 'Такое название уже занято. Выберите другое.' },
  APP_PROJECT_EXISTS: { status: 409, userMessage: 'Проект с таким названием уже есть.' },
  APP_SEARCH_FAILED: { status: 500, userMessage: 'Поиск сейчас не работает. Попробуйте ещё раз.' },
  APP_PROJECT_SAVE_FAILED: { status: 500, userMessage: 'Не удалось сохранить проект. Попробуйте ещё раз.' },
  APP_ADMIN_DELETE_PARTIAL: {
    status: 500,
    userMessage: 'Удалено не всё. Нажмите «Удалить» ещё раз — повтор безопасен. Пока удаление не завершено, сотрудник заблокирован.',
  },
  APP_MODEL_GATEWAY_UNAVAILABLE: { status: 503, userMessage: 'Сервис моделей сейчас не отвечает. Попробуйте через минуту; если повторяется — сообщите администратору код ошибки.' },
  APP_MODEL_UNAVAILABLE: { status: 503, userMessage: 'Модель сейчас не отвечает. Попробуйте ещё раз через минуту; если повторяется — сообщите администратору код ошибки.' },
  APP_MODEL_RATE_LIMITED: { status: 429, userMessage: 'Слишком много запросов к модели. Подождите минуту и отправьте сообщение снова.' },
  APP_MODEL_AUTH_FAILED: { status: 502, userMessage: 'Не удалось обратиться к модели: проблема с настройками доступа. Сообщите администратору код ошибки.' },
  APP_MODEL_CONTEXT_EXCEEDED: { status: 400, userMessage: 'Разговор стал слишком длинным для модели. Начните новый — агент помнит важное о вас.' },
  APP_USAGE_LIMIT_EXCEEDED: {
    status: 402,
    userMessage: 'Ваш лимит расходов на этот месяц исчерпан. Новый лимит начнётся {date}. Если нужно раньше — обратитесь к администратору.',
  },
  APP_USAGE_ORG_LIMIT_EXCEEDED: { status: 402, userMessage: 'Лимит расходов организации на этот месяц исчерпан. Новый лимит начнётся {date}. Обратитесь к администратору.' },
  APP_USAGE_DAILY_CAP_EXCEEDED: {
    status: 402,
    userMessage: 'На сегодня ваш лимит запросов к модели исчерпан. Он обновится завтра; если нужно раньше — обратитесь к администратору.',
  },
  APP_MASKING_FAILED: {
    status: 500,
    userMessage: 'Не удалось подготовить запрос к модели: не сработала защита персональных данных. Попробуйте ещё раз; если повторяется — сообщите администратору код ошибки.',
  },
  APP_SANDBOX_UNAVAILABLE: {
    status: 503,
    userMessage: 'Не удалось запустить рабочую среду агента. Попробуйте ещё раз через минуту; если повторяется — сообщите администратору код ошибки.',
  },
  APP_SANDBOX_BUSY: { status: 503, userMessage: 'Рабочая среда сейчас занята другими задачами. Попробуйте через минуту.' },
  APP_UPLOAD_TOO_LARGE: { status: 413, userMessage: 'Файл больше 20 МБ. Сожмите его или разделите на части.' },
  APP_UPLOAD_TYPE_UNSUPPORTED: {
    status: 415,
    userMessage: 'Такой формат агент пока не читает. Подойдут PDF, Word, Excel, CSV, TXT и картинки PNG или JPG.',
  },
  APP_BACKGROUND_RUN_SKIPPED: { status: 409, userMessage: 'Запуск задачи пропущен: предыдущий запуск ещё ждёт вашего решения.' },
  APP_BACKGROUND_RUN_FAILED: { status: 500, userMessage: 'Задача не выполнилась. Можно запустить её снова.' },
  APP_APPROVAL_EXPIRED: { status: 410, userMessage: 'Истекло: действие не выполнено. Если оно ещё нужно, запустите задачу снова.' },
  APP_APPROVAL_DECIDED: { status: 409, userMessage: 'По этому действию решение уже принято.' },
} satisfies Record<`APP_${string}`, CatalogEntry>;

export type CatalogCode = keyof typeof ERROR_CATALOG;

export function appError(
  code: CatalogCode,
  message: string,
  extra: { cause?: unknown; details?: Record<string, unknown>; userMessage?: string } = {},
): AppError {
  const entry: CatalogEntry = ERROR_CATALOG[code];
  return new AppError({
    code,
    message,
    userMessage: extra.userMessage ?? entry.userMessage,
    status: entry.status,
    ...(entry.nextStep ? { nextStep: entry.nextStep } : {}),
    ...(extra.cause !== undefined ? { cause: extra.cause } : {}),
    ...(extra.details ? { details: extra.details } : {}),
  });
}
