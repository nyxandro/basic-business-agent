// Notifications of this browser (docs/specs/[20.11.2026]-notifications.md, sections 7 and 9): can it show them at all,
// did the person allow them, and does the server keep its subscription for this very person. Turning on asks the
// browser's permission, registers the handler /sw.js and hands the subscription to the server; turning off and
// signing out drop it in the browser first (that works without our server), then on the server.
import { dropSubscription, fetchPushKey, saveSubscription, subscriptionStatus } from './api.ts';

export type PushState = 'checking' | 'unsupported' | 'insecure' | 'ios-home-screen' | 'denied' | 'off' | 'on';

export const SW_URL = '/sw.js';
// What the handler sends a tab of the app on a click (src/sw/sw.ts keeps the same name).
export const OPEN_MESSAGE = 'bba-open';
const SW_SCOPE = '/';

// The person closed the browser's question without an answer.
export class PushNotAllowed extends Error {
  constructor() {
    super('notification permission was not granted');
  }
}

// iPadOS calls itself a Mac; a Mac with touch is an iPad.
function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function fromHomeScreen(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

// What can be told without asking anybody; null — the browser can, the rest depends on the subscription.
export function fixedState(): PushState | null {
  if (!window.isSecureContext) return 'insecure';
  if (isIos() && !fromHomeScreen()) return 'ios-home-screen';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return null;
}

async function ownSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  return (await registration?.pushManager.getSubscription()) ?? null;
}

export async function currentState(): Promise<PushState> {
  const fixed = fixedState();
  if (fixed) return fixed;
  const subscription = await ownSubscription();
  if (!subscription || Notification.permission !== 'granted') return 'off';
  // The browser has a subscription — the server says whether it is this person's. One left by another person (signed
  // out by an ended session, not by «Выйти») is dropped in the browser: their news stops coming to this screen, and
  // the push service then tells the server it is gone.
  if ((await subscriptionStatus(subscription.endpoint)).subscribed) return 'on';
  await subscription.unsubscribe();
  return 'off';
}

function base64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function sameKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === wanted.length && bytes.every((b, i) => b === wanted[i]);
}

// Must be called from a click: browsers ask for permission only on the person's own action.
export async function enablePush(): Promise<PushState> {
  const fixed = fixedState();
  if (fixed) return fixed;
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') throw new PushNotAllowed();
  const registration = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  await navigator.serviceWorker.ready;
  const key = base64Url((await fetchPushKey()).publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made for other keys (another installation on this address earlier) never gets a push.
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await saveSubscription(subscription.toJSON());
  return 'on';
}

export async function disablePush(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const subscription = await ownSubscription();
  if (!subscription) return;
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  await dropSubscription(endpoint);
}

// Signing out: this browser stops getting the person's notifications (a shared computer). Never blocks the sign-out.
export async function dropPushOnSignOut(): Promise<void> {
  try {
    await disablePush();
  } catch (error) {
    console.warn('push subscription not dropped at sign-out', error);
  }
}

// At every start of the app in a browser that allowed notifications: the current handler (a fix to it reaches the
// person), and the subscription checked to be this person's.
export function keepOwnSubscription(): void {
  if (fixedState() !== null || Notification.permission !== 'granted') return;
  navigator.serviceWorker
    .register(SW_URL, { scope: SW_SCOPE })
    .then(() => currentState())
    .catch((error: unknown) => console.warn('notification handler not checked', error));
}
