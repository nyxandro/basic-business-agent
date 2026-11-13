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
  APP_ADMIN_DELETE_PARTIAL: {
    status: 500,
    userMessage: 'Удалено не всё. Нажмите «Удалить» ещё раз — повтор безопасен. Пока удаление не завершено, сотрудник заблокирован.',
  },
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
