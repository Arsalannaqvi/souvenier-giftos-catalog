# Staged Updates

Workflow: when a preview is approved ("I like it"), it's logged under **Pending**
below instead of shipping right away. Pending updates sit here, implemented but
not live — work keeps moving to the next idea. Saying "make it live" (or similar)
implements and pushes everything in **Pending** in one batch; each item then
moves down into **Shipped** with its commit hash and ship date.

Ask "how many pending" any time for a quick count.

## Pending (1)

1. **Bulk quotation builder** — adds Branding (logo engraving / screen print /
   embroidery / no branding), delivery city, needed-by date, recipient count,
   and budget-per-recipient (indicative, labelled as such) to the shortlist
   form; sending now goes through a Review screen first (Edit / Confirm) before
   opening WhatsApp with a fully itemized, structured message instead of
   today's loose list. Files: `index.html`, `css/styles.css`, `js/app.js`.
   Implemented and tested locally (desktop + mobile, full send flow verified);
   committed locally, not yet pushed.

## Shipped

- **2026-10-09** — Dark navy / electric-blue / violet "futuristic luxury" rebrand
  (hero/welcome-screen glow, gradient CTAs and price text, Space Grotesk +
  Inter typography, gradient size-picker pills) — `8116747a`
  _(shipped immediately, before this staging workflow was set up)_
