// A card of a client, a product, a plan (spec, section 8.31; mockup «Экраны агента: набор компонентов», № 68). Ours in
// place of CopilotKit's: its buttons can be neither marked nor made inactive, and a choice between plans by cards is
// where the mark of the chosen one matters most (owner 20.11). The recommended one — a badge of the accent colour — is
// on glass, with a white main button (the agent's rules say so). Only pictures of our own server; another site's — a
// link under the card (F36).
import type { GenerativeUIComponentProps, standardUI } from '@copilotkit/react-core/generative-ui';
import { useContext, type ReactNode } from 'react';
import { ru } from '../i18n/ru.ts';
import { cx } from '../ui/Button.tsx';
import { Icon } from '../ui/Icon.tsx';
import { ForeignPicture, ownAddress, safeHref } from './addresses.tsx';
import { useBusyGuard } from './busy.tsx';
import { WidgetReplyContext } from './reply.ts';
import styles from './widgets.module.css';

type Props = GenerativeUIComponentProps<typeof standardUI, 'EntityCard'>;
type Action = NonNullable<Props['actions']>[number];

const BADGE: Record<string, string | undefined> = { success: styles.badgeSuccess, danger: styles.badgeDanger, warning: styles.badgeWarning, info: styles.badgeInfo };

// The letters of a name for a card without a picture laid out in a row: «ООО Стройресурс» — «СР».
function initials(title: string): string {
  const words = title.replace(/[«»"']/g, '').split(/\s+/).filter((w) => w.length > 0 && !/^(ООО|ОАО|ЗАО|ПАО|АО|ИП)$/i.test(w));
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || title.slice(0, 1).toUpperCase();
}

function Stars({ rating, count }: { rating: number; count: number | undefined }) {
  const full = Math.round(Math.max(0, Math.min(5, rating)));
  return (
    <span className={styles.cardStars} aria-label={ru.widgets.rating(rating, count)}>
      {'★'.repeat(full)}
      <span className={styles.cardStarsOff}>{'★'.repeat(5 - full)}</span>
      {count !== undefined && <span className={styles.cardMuted}> {count}</span>}
    </span>
  );
}

function ActionButton({ action, main, glass, onAction }: { action: Action; main: boolean; glass: boolean; onAction: ((args: { label: string }) => unknown) | undefined }) {
  const { answered, chosen } = useContext(WidgetReplyContext);
  const href = safeHref(action.href);
  const solid = action.variant === 'solid' || (glass && main);
  const className = glass ? (solid ? styles.glassMain : styles.glassSecond) : cx(styles.cardAction, solid && styles.cardActionMain);
  if (href) {
    return (
      <a className={className} href={href} target="_blank" rel="noopener noreferrer">
        {action.label}
      </a>
    );
  }
  const isChosen = answered && chosen.has(action.label);
  return (
    <button type="button" className={cx(className, isChosen && styles.chosen)} disabled={answered || !onAction} data-chosen={isChosen || undefined} onClick={() => void onAction?.({ label: action.label })}>
      {isChosen ? <Icon name="check" size={15} /> : null}
      {action.label}
      {isChosen ? <span className="visually-hidden">{ru.genui.chosen}</span> : null}
    </button>
  );
}

export function EntityCard(props: Props): ReactNode {
  const onAction = useBusyGuard(props.onAction);
  const onClick = useBusyGuard(props.onClick);
  const glass = props.badge?.color === 'discovery';
  const horizontal = props.layout === 'horizontal';
  const image = typeof props.image === 'string' && props.image !== '' ? props.image : null;
  const ownImage = image && ownAddress(image) ? image : null;
  const href = safeHref(props.href);
  const actions = (props.actions ?? []).slice(0, 3);
  const mainIndex = actions.findIndex((a) => a.variant === 'solid');
  const open = href ? () => window.open(href, '_blank', 'noopener,noreferrer') : onClick ? () => void onClick({}) : undefined;

  const picture = ownImage ? (
    <img className={horizontal ? styles.cardAvatar : styles.cardImage} src={ownImage} alt="" style={horizontal ? undefined : { aspectRatio: props.imageAspectRatio ?? '4 / 3' }} />
  ) : horizontal ? (
    <span className={cx(styles.cardAvatar, styles.cardInitials)} aria-hidden="true">
      {initials(props.title)}
    </span>
  ) : null;

  return (
    <>
      <div
        className={cx(glass ? cx(styles.glass, styles.cardGlass) : styles.card, horizontal && styles.cardRow, open && styles.cardClickable)}
        style={typeof props.width === 'number' ? { width: `${props.width * 4}px` } : typeof props.width === 'string' ? { width: props.width } : undefined}
        role={open ? 'link' : undefined}
        tabIndex={open ? 0 : undefined}
        onClick={open}
        onKeyDown={open ? (event) => (event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget && (event.preventDefault(), open()) : undefined}
      >
        {picture}
        <div className={styles.cardBody}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>{props.title}</span>
            {props.badge && <span className={glass ? styles.glassPill : cx(styles.cardBadge, BADGE[props.badge.color ?? ''])}>{props.badge.label}</span>}
          </div>
          {props.subtitle && <span className={glass ? styles.glassMuted : styles.cardMuted}>{props.subtitle}</span>}
          {props.meta && <span className={styles.cardMeta}>{props.meta}</span>}
          {typeof props.rating === 'number' && <Stars rating={props.rating} count={props.ratingCount} />}
          {props.description && <span className={styles.cardText}>{props.description}</span>}
        </div>
        {actions.length > 0 && (
          // A press of a button is not a press of the card.
          <div className={horizontal ? styles.cardActionsSide : styles.cardActions} onClick={(event) => event.stopPropagation()} role="presentation">
            {actions.map((action, i) => (
              <ActionButton key={`${action.label}-${i}`} action={action} main={mainIndex < 0 ? i === 0 : i === mainIndex} glass={glass} onAction={onAction} />
            ))}
          </div>
        )}
      </div>
      {image && !ownImage && <ForeignPicture url={image} />}
    </>
  );
}
