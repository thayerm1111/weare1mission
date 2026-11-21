/**
 * LEAVING THE SITE FOR A PAYMENT OR BILLING PAGE (Stripe's checkout and billing portal).
 *
 * The members' installed app shows the site inside a frame (public/app/index.html: phones keep a Home Screen app to
 * the address it was installed from), and a payment page refuses to open inside a frame. So from inside that frame
 * the whole app goes to the page instead — on a phone it opens over the app, which is still there when it is closed.
 * In a browser tab, or the new installed app, it is an ordinary navigation.
 */
export function leaveFor(url: string): void {
  try {
    if (window.top && window.top !== window.self) {
      window.top.location.href = url;
      return;
    }
  } catch { /* a parent on another site: this page navigates instead */ }
  window.location.href = url;
}
