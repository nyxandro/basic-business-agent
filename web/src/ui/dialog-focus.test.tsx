import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ConfirmProvider, useConfirm } from './Confirm.tsx';
import { Modal } from './Modal.tsx';

function Editor() {
  const [open, setOpen] = useState(true);
  const confirm = useConfirm();
  return (
    <Modal open={open} onClose={() => setOpen(false)} label="Отдел">
      <input aria-label="Название" />
      <button type="button" onClick={() => void confirm({ title: 'Удалить отдел?', confirmLabel: 'Удалить', danger: true })}>
        Удалить отдел
      </button>
    </Modal>
  );
}

describe('a question over a dialog', () => {
  it('closes only the question on Esc and keeps Tab inside it', async () => {
    render(
      <ConfirmProvider>
        <Editor />
      </ConfirmProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Удалить отдел' }));
    const question = screen.getByRole('alertdialog', { name: 'Удалить отдел?' });
    await user.tab();
    expect(question).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Отдел' })).toBeInTheDocument();
  });
});
