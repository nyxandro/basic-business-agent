// Connector errors for people (spec, section 9); the system's title goes into the text.
import { AppError } from '../errors/app-error.ts';

export function notConnected(title: string, connectorId: string): AppError {
  return new AppError({
    code: 'APP_CONNECTOR_NOT_CONNECTED',
    message: `employee has no credential for ${connectorId}`,
    userMessage: `Чтобы агент работал с ${title} от вашего имени, подключите её в настройках → «Подключения».`,
    status: 409,
    details: { connectorId, link: '/settings/connections' },
  });
}

export function authFailed(title: string, connectorId: string, cause?: unknown): AppError {
  return new AppError({
    code: 'APP_CONNECTOR_AUTH_FAILED',
    message: `${connectorId} rejected the employee's credential`,
    userMessage: `${title} не приняла ваш доступ — возможно, он истёк. Переподключите её в настройках.`,
    status: 401,
    details: { connectorId },
    ...(cause !== undefined ? { cause } : {}),
  });
}

// The sign-in on the system's site did not end with tokens: the link is old, the person cancelled, the system refused.
export function signInNotFinished(title: string, details: Record<string, unknown>, cause?: unknown): AppError {
  return new AppError({
    code: 'APP_CONNECTOR_AUTH_FAILED',
    message: 'the sign-in on the system site did not finish',
    userMessage: `Вход в ${title} не завершён: ссылка устарела или вход отменён. Нажмите «Подключить» ещё раз.`,
    status: 401,
    details,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export function unavailable(title: string, connectorId: string, cause?: unknown): AppError {
  return new AppError({
    code: 'APP_CONNECTOR_UNAVAILABLE',
    message: `${connectorId} is unreachable`,
    userMessage: `${title} сейчас недоступна. Агент продолжит без неё; попробуйте позже.`,
    status: 503,
    details: { connectorId },
    ...(cause !== undefined ? { cause } : {}),
  });
}
