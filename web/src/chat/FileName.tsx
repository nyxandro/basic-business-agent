// The name of an attached file: cut in the middle when it does not fit — its start shrinks to «…», its
// end stays: «Отчёт (2).docx» and «Отчёт.docx» are told apart when both are longer than the row. The end
// is the last word before the extension (after a space, «_» or «-») when that word is short, otherwise
// its last letters. It moves with its chip without being stretched by the chip's scale (Motion,
// layout="position").
import { motion } from 'motion/react';
import styles from './attachments.module.css';

const NAME_TAIL_WORD = 12;
const NAME_TAIL_LETTERS = 6;

function tailStart(name: string): number {
  const dot = name.lastIndexOf('.');
  const stemEnd = dot > 0 ? dot : name.length;
  const stem = name.slice(0, stemEnd);
  const cut = Math.max(stem.lastIndexOf(' '), stem.lastIndexOf('_'), stem.lastIndexOf('-'));
  return cut > 0 && stemEnd - cut <= NAME_TAIL_WORD ? cut : Math.max(0, stemEnd - NAME_TAIL_LETTERS);
}

export function FileName({ name }: { name: string }) {
  const start = tailStart(name);
  return (
    <motion.span layout="position" className={styles.chipName} title={name} data-chip-name>
      <span className={styles.chipNameHead}>{name.slice(0, start)}</span>
      <span className={styles.chipNameTail}>{name.slice(start)}</span>
    </motion.span>
  );
}
