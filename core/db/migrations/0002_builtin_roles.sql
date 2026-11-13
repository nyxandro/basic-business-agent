-- Built-in roles (spec, section 8.2): the superadmin has every right; an employee has none
-- in the admin panel. Neither can be deleted; the superadmin's rights cannot be narrowed.
INSERT INTO app.roles (name, permissions, builtin) VALUES
  ('Суперадминистратор', '[]'::jsonb, 'superadmin'),
  ('Сотрудник', '[]'::jsonb, 'employee');
