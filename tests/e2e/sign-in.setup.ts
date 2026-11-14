// Signs the people of the stand in through the form once and saves their sessions for the scenarios.
import { test as setup } from '@playwright/test';
import { sessionFile, signInWithForm, STAND_PEOPLE } from './helpers.ts';

setup('sign in the people of the stand', async ({ browser }) => {
  for (const email of STAND_PEOPLE) {
    const context = await browser.newContext();
    await signInWithForm(await context.newPage(), email);
    await context.storageState({ path: sessionFile(email) });
    await context.close();
  }
});
