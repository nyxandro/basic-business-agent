// Sections of the admin panel in menu order (spec, section 12) and who may open them.
import type { AdminSection, MeResponse } from '@bba/contracts';

export const SECTIONS: { id: AdminSection; path: string; label: string }[] = [
  { id: 'users', path: 'users', label: 'Пользователи' },
  { id: 'roles', path: 'roles', label: 'Роли' },
  { id: 'departments', path: 'departments', label: 'Отделы' },
  { id: 'limits', path: 'limits', label: 'Лимиты' },
  { id: 'usage', path: 'usage', label: 'Расходы' },
  { id: 'agents', path: 'agents', label: 'Агенты' },
  { id: 'org_profile', path: 'org-profile', label: 'Профиль организации' },
  { id: 'masking', path: 'masking', label: 'Маскирование' },
  { id: 'connections', path: 'connections', label: 'Подключения' },
  { id: 'journal', path: 'journal', label: 'Журнал действий' },
];

// Names of rights in the role editor; the document rights are reserved for the knowledge base.
export const PERMISSION_LABELS: Record<string, string> = {
  ...Object.fromEntries(SECTIONS.map((s) => [s.id, s.label])),
  models: 'Нейросеть',
  skills: 'Скиллы',
  'documents.org.manage': 'Документы организации',
  'documents.department.manage': 'Документы отдела',
};

export const canOpen = (me: MeResponse, section: AdminSection): boolean => me.isSuperadmin || me.permissions.includes(section);

export const availableSections = (me: MeResponse) => SECTIONS.filter((s) => canOpen(me, s.id));
