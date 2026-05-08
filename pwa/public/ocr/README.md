# Vendored OCR assets

`eng.traineddata.gz` is the English language data for Tesseract OCR
(Apache 2.0 licensed, sourced from `tesseract-ocr/tessdata_fast`).

We vendor it same-origin so the Service Worker's same-origin guard
can cache it (the SW intercepts only same-origin requests). The
~10 MB asset is fetched once on the OcrQueue's first job and
cached thereafter for offline reuse.

## Updating

When tessdata ships a new build:

    curl -fsSL --output eng.traineddata \
      https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata
    gzip -9 eng.traineddata

Verify with `gunzip -t`. Retest on a real device, commit.
