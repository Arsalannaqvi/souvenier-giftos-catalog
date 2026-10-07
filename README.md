# Souvenier Giftos — Client Catalog

Public, client-facing static site: browse categories, shortlist products, and
send an enquiry via WhatsApp.

Deployed via GitHub Pages from this repo's `main` branch (root). Previously
on Netlify, but its production-deploy credits ran out for the billing cycle
and deploys stopped landing (2026-10-07), so the site moved to GitHub Pages
— free, no credit limits, same git-push-to-deploy flow. One feature was
dropped in the move: the "Submit Enquiry" button used Netlify's built-in
form backend, which doesn't exist on GitHub Pages. "Send on WhatsApp" is now
the only enquiry path.

**Live site:** https://arsalannaqvi.github.io/souvenier-giftos-catalog/

This is a deliberately slim, public mirror of just the catalog site — the
business's internal working repo (pricing rules, scraping notes, Notion
config, etc.) stays separate and private.

See `data/config.json` to edit the business name, sales team, and curated
client lists; `data/products.json` for the product catalog itself.
