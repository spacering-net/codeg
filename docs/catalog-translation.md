# Translate catalog descriptions before installing

Open **Harness Engineering → Discover** and choose **Translate (Google)** to
read public catalog titles, summaries and description prose in the interface
language. The preference is remembered by this browser. **Show original**
returns to the publisher's text; hovering a translated card's title or summary
also shows its original. Text the publisher already supplied in the interface
language takes priority over machine translation.

Translation is off until you enable it. Only public or listed catalog entries
are eligible. Installed skill files, agent messages and installation requests
are not changed. Code spans and blocks, keyboard samples, HTML attributes and
link destinations do not become translation requests. Description translations
are rendered through the existing HTML-to-React allowlist as text, so translated
markup cannot introduce elements or event handlers.

Translations arrive progressively. Requests for the same text and target
language are shared, at most four run at once, and leaving a view cancels work
that no other view needs. Successful results are cached locally by original
text and target language for seven days, with at most 512 entries and 500,000
serialized characters. Browser storage failure falls back to memory. A changed
description gets a new cache key. Failed translations leave the original
readable and can be retried from the controls.

The optional provider currently uses Google's web translation endpoint, without
an API key. This is not the keyed Google Cloud Translation API, and its
availability and access limits can change. Codeg does not send browser cookies,
Codeg access tokens or agent credentials to it. If the service is unavailable,
use the original view or retry. The request function is isolated from the
cache and UI so a supported translation provider can replace it without
changing catalog or installation data.
