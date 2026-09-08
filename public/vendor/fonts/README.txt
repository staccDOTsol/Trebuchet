Bundled fonts for the Trebuchet desktop app.

These are self-hosted (rather than loaded from Google Fonts) because the
app's Content-Security-Policy restricts font-src to 'self' and data: —
external font CDNs are blocked by design in a wallet-handling application.

Families and licenses:
  - IM Fell DW Pica, IM Fell DW Pica SC  (Igino Marini) — see OFL.txt
  - EB Garamond                          (Georg Duffner) — see OFL.txt
  - JetBrains Mono                        (JetBrains)     — see OFL.txt
  - Unbounded (variable, latin + latin-ext) (Unbounded Project) — see OFL.txt

All four are licensed under the SIL Open Font License 1.1. The full
license text is in OFL.txt in this directory. The website
(makesometokens.com) loads the same families from Google Fonts; the app
bundles them to match the visual identity within the CSP constraints.

Source: extracted from the @fontsource npm packages (latin subset, woff2).
