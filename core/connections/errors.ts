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

// A call found the access of the employee gone (HTTP 401): scenario 4 of docs/specs/[20.11.2026]-mcp-connections.md.
export function accessLost(title: string, connectorId: string): AppError {
  return new AppError({
    code: 'APP_CONNECTOR_AUTH_FAILED',
    message: `${connectorId} refused the employee's access (HTTP 401)`,
    userMessage: `Ваш доступ к ${title} больше не работает. Откройте «Настройки → Подключения» и нажмите «Подключить заново».`,
    status: 401,
    details: { connectorId },
  });
}

// The check action did not take the key the employee entered.
export function keyRefused(title: string, connectorId: string): AppError {
  return new AppError({ code: 'APP_CONNECTOR_AUTH_FAILED', message: `${connectorId} refused the key at its check`, userMessage: `${title} не приняла ключ. Проверьте его.`, status: 401, details: { connectorId } });
}

// No right to this one thing (HTTP 403): the connection itself is fine.
export function forbidden(title: string, connectorId: string): AppError {
  return new AppError({ code: 'APP_CONNECTOR_FORBIDDEN', message: `${connectorId} forbade the action (HTTP 403)`, userMessage: `В ${title} у сотрудника нет прав на это.`, status: 403, details: { connectorId } });
}

// The connection broke after the system got the call: it may have run, so it is not repeated.
export function unknownOutcome(title: string, connectorId: string): AppError {
  return new AppError({
    code: 'APP_CONNECTOR_UNKNOWN_OUTCOME',
    message: `${connectorId}: the connection broke after the call was sent`,
    userMessage: `${title} не ответила, и неизвестно, выполнилось ли действие. Проверьте в ${title}, прежде чем повторять.`,
    status: 502,
    details: { connectorId },
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
