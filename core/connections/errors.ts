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
