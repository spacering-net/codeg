//! Screenshots for an agent: the pixels of a shared page, or of one element
//! of it, sized for a model to look at.
//!
//! One pipeline for three engines. Each platform already answers "the
//! viewport as a PNG" (`BrowserSurface::snapshot_png`, which the freeze
//! frame and the owned-window card use); everything a screenshot tool wants
//! beyond that — a crop to an element, a cap on the size — is done here on
//! the decoded image, identically everywhere. Doing it per engine would have
//! meant three coordinate systems (WebKit's snapshot rect is in view points,
//! CDP's clip is in device-independent pixels, WebKitGTK's region has no
//! crop at all) reconciled with three notions of zoom; doing it once on
//! pixels means the only fact needed is how many pixels the engine drew per
//! CSS pixel, and the capture itself says that: its width over the
//! viewport's CSS width. Page zoom and display scale both fall out of that
//! ratio without being asked about.
//!
//! The cost is a decode and an encode of one screenshot per call, tens of
//! milliseconds; the tool is called by an agent thinking about a page, not in
//! a loop.

use image::{imageops::FilterType, DynamicImage, ImageFormat};
use serde::{Deserialize, Serialize};

/// Output width when the caller names none: the widest a screenshot needs to
/// be to read its text, and about as large as a vision model takes in before
/// scaling it down itself.
pub const DEFAULT_CAPTURE_MAX_WIDTH: u32 = 1568;

/// The most a caller may ask for. A capture is a viewport; a larger number
/// only upsamples.
pub const CAPTURE_MAX_WIDTH_CEILING: u32 = 4096;

/// JPEG quality when that format is asked for. Text stays legible; a page of
/// photographs drops to a fraction of the PNG.
pub const CAPTURE_JPEG_QUALITY: u8 = 85;

/// The most a capture may weigh once encoded. Base64 adds a third and the
/// JSON around it adds little, so this keeps the answer well inside the
/// broker's 16 MiB frame and under what a vision model accepts for one image
/// (5 MB with the base64). A screenshot of a page is far below it; a canvas
/// full of noise at 4096 wide is not, and is scaled down until it is —
/// `max_width` is a ceiling, not a promise.
pub const CAPTURE_MAX_ENCODED_BYTES: usize = 3_500_000;

/// Narrower than this and a screenshot shows nothing; the budget loop stops
/// here rather than shrinking to a dot.
const CAPTURE_MIN_WIDTH: u32 = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CaptureFormat {
    #[default]
    Png,
    Jpeg,
}

impl CaptureFormat {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "png" => Some(Self::Png),
            "jpeg" => Some(Self::Jpeg),
            _ => None,
        }
    }
}

/// What an agent asks a capture for. `generation` and `ref` name an element
/// from a snapshot to crop to; both or neither.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// Output width in pixels; the height follows. Absent or `0` is
    /// [`DEFAULT_CAPTURE_MAX_WIDTH`]; capped at [`CAPTURE_MAX_WIDTH_CEILING`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_width: Option<u32>,
    #[serde(default)]
    pub format: CaptureFormat,
}

impl CaptureRequest {
    /// The element to crop to, when the request names one.
    pub fn clip_target(&self) -> Option<(&str, &str)> {
        match (self.generation.as_deref(), self.target.as_deref()) {
            (Some(generation), Some(target)) => Some((generation, target)),
            _ => None,
        }
    }
}

/// A rectangle of the page in viewport CSS pixels.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What an agent gets back.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOutcome {
    pub mime: String,
    /// The image, base64.
    pub data: String,
    /// Pixel size of the image as delivered.
    pub width: u32,
    pub height: u32,
    /// Where the page was when the pixels were taken.
    pub url: String,
    /// The part of the viewport the image shows, in CSS pixels — the whole
    /// viewport, or the element's visible box — so the agent can relate it
    /// to a snapshot's coordinates.
    pub region: CaptureRegion,
    /// Whether `region` is an element rather than the viewport.
    pub clipped: bool,
}

/// A capture after cropping, scaling and encoding.
#[derive(Debug, Clone, PartialEq)]
pub struct Fitted {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// The output width a request means.
pub fn effective_max_width(requested: Option<u32>) -> u32 {
    match requested {
        None | Some(0) => DEFAULT_CAPTURE_MAX_WIDTH,
        Some(n) => n.min(CAPTURE_MAX_WIDTH_CEILING),
    }
}

/// Crop the engine's viewport capture to `clip` (CSS pixels, if any), scale
/// it down to at most `max_width` wide, and encode it as `format`.
///
/// `css_width` is the viewport's width in CSS pixels at the moment of the
/// capture; the ratio of the image's width to it is how many pixels the
/// engine drew per CSS pixel, which is what turns a clip into pixel
/// coordinates. A clip that lands on no pixels — an element scrolled off, or
/// a zero-area box — is an error, since an empty image would look like a
/// blank page rather than a miss.
pub fn fit(
    encoded: &[u8],
    css_width: f64,
    clip: Option<CaptureRegion>,
    max_width: u32,
    format: CaptureFormat,
) -> Result<Fitted, String> {
    fit_within(encoded, css_width, clip, max_width, format, CAPTURE_MAX_ENCODED_BYTES)
}

/// [`fit`] with the encoded-size budget as a parameter, for the tests that
/// want to see the loop turn without encoding megabytes of noise.
pub fn fit_within(
    encoded: &[u8],
    css_width: f64,
    clip: Option<CaptureRegion>,
    max_width: u32,
    format: CaptureFormat,
    budget: usize,
) -> Result<Fitted, String> {
    let image = image::load_from_memory(encoded)
        .map_err(|e| format!("the capture could not be decoded: {e}"))?;
    let (full_width, full_height) = (image.width(), image.height());
    if full_width == 0 || full_height == 0 {
        return Err("the engine drew an empty capture".to_string());
    }
    if let Some(region) = clip {
        // A box has to be a box before it is rounded outwards: a zero-width
        // region at a fractional offset would otherwise round to one pixel
        // and come back as an image of nothing in particular.
        let finite = [region.x, region.y, region.width, region.height]
            .iter()
            .all(|v| v.is_finite());
        if !finite || region.width <= 0.0 || region.height <= 0.0 {
            return Err("the element has no visible area to capture".to_string());
        }
        // And the ratio that places it in the capture has to be known.
        if !css_width.is_finite() || css_width <= 0.0 {
            return Err(
                "the viewport's width is unknown, so the element cannot be located in the capture"
                    .to_string(),
            );
        }
    }
    let scale = if css_width.is_finite() && css_width > 0.0 {
        f64::from(full_width) / css_width
    } else {
        1.0
    };
    let image = match clip {
        Some(region) => {
            let x0 = (region.x * scale).floor().clamp(0.0, f64::from(full_width)) as u32;
            let y0 = (region.y * scale).floor().clamp(0.0, f64::from(full_height)) as u32;
            let x1 = ((region.x + region.width) * scale)
                .ceil()
                .clamp(0.0, f64::from(full_width)) as u32;
            let y1 = ((region.y + region.height) * scale)
                .ceil()
                .clamp(0.0, f64::from(full_height)) as u32;
            if x1 <= x0 || y1 <= y0 {
                return Err("the element has no visible area to capture".to_string());
            }
            image.crop_imm(x0, y0, x1 - x0, y1 - y0)
        }
        None => image,
    };
    let mut image = narrow_to(image, max_width.max(1));
    loop {
        let bytes = encode(&image, format)?;
        if bytes.len() <= budget || image.width() <= CAPTURE_MIN_WIDTH {
            return Ok(Fitted {
                width: image.width(),
                height: image.height(),
                bytes,
            });
        }
        // Over the budget: the encoded size grows with the area, so the
        // width comes down by the square root of the overshoot, and a
        // little more so that one more pass is the rare case.
        let ratio = (budget as f64 / bytes.len() as f64).sqrt() * 0.9;
        let narrower = ((f64::from(image.width()) * ratio).floor() as u32)
            .clamp(CAPTURE_MIN_WIDTH, image.width().saturating_sub(1).max(CAPTURE_MIN_WIDTH));
        image = narrow_to(image, narrower);
    }
}

/// Scale the image down to `width` pixels wide, keeping its aspect; never up.
fn narrow_to(image: DynamicImage, width: u32) -> DynamicImage {
    if image.width() <= width {
        return image;
    }
    let height = (f64::from(image.height()) * f64::from(width) / f64::from(image.width()))
        .round()
        .max(1.0) as u32;
    image.resize_exact(width, height, FilterType::Triangle)
}

fn encode(image: &DynamicImage, format: CaptureFormat) -> Result<Vec<u8>, String> {
    let mut out = std::io::Cursor::new(Vec::new());
    match format {
        CaptureFormat::Png => image
            .write_to(&mut out, ImageFormat::Png)
            .map_err(|e| format!("png encoding failed: {e}"))?,
        CaptureFormat::Jpeg => {
            // JPEG has no alpha; a transparent capture is drawn on white by
            // dropping the channel, which is what the page's own background
            // would have been.
            let opaque = DynamicImage::ImageRgb8(image.to_rgb8());
            let encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, CAPTURE_JPEG_QUALITY);
            opaque
                .write_with_encoder(encoder)
                .map_err(|e| format!("jpeg encoding failed: {e}"))?;
        }
    }
    Ok(out.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    /// A 200×100 PNG whose left half is red and right half is blue, standing
    /// for a 100 CSS-pixel-wide viewport drawn at 2× — the shape a Retina
    /// display produces.
    fn two_tone() -> Vec<u8> {
        let mut img = RgbaImage::new(200, 100);
        for (x, _, p) in img.enumerate_pixels_mut() {
            *p = if x < 100 {
                Rgba([255, 0, 0, 255])
            } else {
                Rgba([0, 0, 255, 255])
            };
        }
        let mut out = std::io::Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(img)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    fn decode(bytes: &[u8]) -> DynamicImage {
        image::load_from_memory(bytes).unwrap()
    }

    #[test]
    fn a_whole_capture_is_only_scaled_down_and_never_up() {
        let fitted = fit(&two_tone(), 100.0, None, 50, CaptureFormat::Png).unwrap();
        assert_eq!((fitted.width, fitted.height), (50, 25));
        assert!(fitted.bytes.starts_with(&[0x89, b'P', b'N', b'G']));
        let untouched = fit(&two_tone(), 100.0, None, 4096, CaptureFormat::Png).unwrap();
        assert_eq!((untouched.width, untouched.height), (200, 100));
    }

    /// A clip is given in CSS pixels and lands on the pixels the engine drew
    /// for them: the right half of a 100-CSS-pixel viewport is the blue half
    /// of the 200-pixel capture.
    #[test]
    fn a_clip_in_css_pixels_lands_on_the_right_pixels() {
        let region = CaptureRegion {
            x: 50.0,
            y: 0.0,
            width: 50.0,
            height: 50.0,
        };
        let fitted = fit(&two_tone(), 100.0, Some(region), 4096, CaptureFormat::Png).unwrap();
        assert_eq!((fitted.width, fitted.height), (100, 100));
        let img = decode(&fitted.bytes).to_rgba8();
        assert_eq!(img.get_pixel(0, 0), &Rgba([0, 0, 255, 255]));
        assert_eq!(img.get_pixel(99, 99), &Rgba([0, 0, 255, 255]));
    }

    #[test]
    fn a_clip_is_clamped_to_the_capture_and_refused_when_empty() {
        // The fixture is 100×50 CSS pixels; a box hanging off its corner is
        // cut to the part that is on it.
        let hanging = CaptureRegion {
            x: 90.0,
            y: 40.0,
            width: 40.0,
            height: 40.0,
        };
        let fitted = fit(&two_tone(), 100.0, Some(hanging), 4096, CaptureFormat::Png).unwrap();
        assert_eq!((fitted.width, fitted.height), (20, 20));

        let gone = CaptureRegion {
            x: 120.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        };
        assert!(fit(&two_tone(), 100.0, Some(gone), 4096, CaptureFormat::Png)
            .unwrap_err()
            .contains("no visible area"));
        let flat = CaptureRegion {
            x: 10.0,
            y: 10.0,
            width: 0.0,
            height: 0.0,
        };
        assert!(fit(&two_tone(), 100.0, Some(flat), 4096, CaptureFormat::Png).is_err());
    }

    /// Pixels nothing can compress: the case a page's own screenshot never
    /// is, and the one the budget exists for.
    fn noise(width: u32, height: u32) -> Vec<u8> {
        let mut state: u32 = 0x9e37_79b9;
        let mut img = RgbaImage::new(width, height);
        for p in img.pixels_mut() {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let [a, b, c, _] = state.to_le_bytes();
            *p = Rgba([a, b, c, 255]);
        }
        let mut out = std::io::Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(img)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }

    /// A capture that would not fit the budget is scaled down until it does
    /// — `maxWidth` is a ceiling — and one that fits is left at the size it
    /// asked for.
    #[test]
    fn a_capture_over_the_budget_is_narrowed_until_it_fits() {
        let png = noise(256, 128);
        let budget = 40_000;
        let fitted = fit_within(&png, 256.0, None, 4096, CaptureFormat::Png, budget).unwrap();
        assert!(fitted.bytes.len() <= budget, "{} bytes over {budget}", fitted.bytes.len());
        assert!(fitted.width < 256 && fitted.width >= CAPTURE_MIN_WIDTH);
        assert_eq!(fitted.height, (f64::from(fitted.width) / 2.0).round() as u32);

        let roomy = fit_within(&png, 256.0, None, 4096, CaptureFormat::Png, usize::MAX).unwrap();
        assert_eq!((roomy.width, roomy.height), (256, 128));

        // Even a budget nothing can meet stops at the floor rather than
        // shrinking to a dot or looping.
        let floor = fit_within(&png, 256.0, None, 4096, CaptureFormat::Png, 1).unwrap();
        assert_eq!(floor.width, CAPTURE_MIN_WIDTH);
    }

    /// A clip has to be a box in a viewport whose width is known; a zero-area
    /// region at a fractional offset must not round up to a pixel of nothing.
    #[test]
    fn a_clip_must_be_a_real_box_in_a_known_viewport() {
        let dot = CaptureRegion {
            x: 0.25,
            y: 0.25,
            width: 0.0,
            height: 0.0,
        };
        assert!(fit(&two_tone(), 100.0, Some(dot), 4096, CaptureFormat::Png)
            .unwrap_err()
            .contains("no visible area"));
        let nan = CaptureRegion {
            x: f64::NAN,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        };
        assert!(fit(&two_tone(), 100.0, Some(nan), 4096, CaptureFormat::Png).is_err());
        let fine = CaptureRegion {
            x: 10.0,
            y: 10.0,
            width: 10.0,
            height: 10.0,
        };
        assert!(fit(&two_tone(), 0.0, Some(fine), 4096, CaptureFormat::Png)
            .unwrap_err()
            .contains("viewport's width"));
        assert!(fit(&two_tone(), f64::NAN, Some(fine), 4096, CaptureFormat::Png).is_err());
        // Without a clip an unknown width only means "no scaling to do".
        assert!(fit(&two_tone(), f64::NAN, None, 4096, CaptureFormat::Png).is_ok());
    }

    #[test]
    fn jpeg_is_jpeg_and_smaller() {
        let png = fit(&two_tone(), 100.0, None, 4096, CaptureFormat::Png).unwrap();
        let jpeg = fit(&two_tone(), 100.0, None, 4096, CaptureFormat::Jpeg).unwrap();
        assert!(jpeg.bytes.starts_with(&[0xFF, 0xD8]));
        assert_eq!((jpeg.width, jpeg.height), (200, 100));
        assert!(jpeg.bytes.len() < png.bytes.len() * 4, "not absurdly larger");
        assert_eq!(CaptureFormat::parse("JPEG"), Some(CaptureFormat::Jpeg));
        // Exactly what the tool's schema advertises, nothing beside it.
        assert_eq!(CaptureFormat::parse("jpg"), None);
        assert_eq!(CaptureFormat::parse("gif"), None);
    }

    #[test]
    fn the_width_a_request_means() {
        assert_eq!(effective_max_width(None), DEFAULT_CAPTURE_MAX_WIDTH);
        assert_eq!(effective_max_width(Some(0)), DEFAULT_CAPTURE_MAX_WIDTH);
        assert_eq!(effective_max_width(Some(800)), 800);
        assert_eq!(effective_max_width(Some(99_999)), CAPTURE_MAX_WIDTH_CEILING);
    }

    #[test]
    fn a_request_names_an_element_with_both_halves_or_not_at_all() {
        let whole: CaptureRequest = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(whole.clip_target(), None);
        assert_eq!(whole.format, CaptureFormat::Png);
        let half: CaptureRequest =
            serde_json::from_value(serde_json::json!({ "ref": "e3" })).unwrap();
        assert_eq!(half.clip_target(), None);
        let element: CaptureRequest = serde_json::from_value(
            serde_json::json!({ "generation": "g.1.2", "ref": "e3", "maxWidth": 640, "format": "jpeg" }),
        )
        .unwrap();
        assert_eq!(element.clip_target(), Some(("g.1.2", "e3")));
        assert_eq!(element.max_width, Some(640));
        assert_eq!(element.format, CaptureFormat::Jpeg);
        assert!(fit(b"not an image", 100.0, None, 100, CaptureFormat::Png).is_err());
    }
}
