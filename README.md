# PaintQuote (demo)

Quoting tool for painting companies. Plain static site - no build step, no server. Open `index.html`, or host on GitHub Pages.

- `pricing.js` - the pricing engine (also loaded by the tests)
- `app.js`, `app.css`, `index.html` - the app. Data is saved in the browser (localStorage).
- `test/pricing.test.js` - `node --test test/pricing.test.js`

Deploy: repo Settings > Pages > Deploy from a branch > main, `/ (root)`.

Prices are ballpark Australian starting values; painters edit them on the Prices tab.
