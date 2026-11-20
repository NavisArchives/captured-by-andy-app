//! Everything that looks inside image files goes through macOS ImageIO - the
//! engine behind Finder and Quick Look. It reads JPEG, PNG, HEIC, WebP and every
//! RAW format macOS supports, gets EXIF from the headers without decoding
//! pixels, and can return a RAW file's embedded preview instead of developing it.

use std::ffi::c_void;
use std::path::Path;

use objc2_core_foundation::{
    CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CFURL, CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::{CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGInterpolationQuality};
use objc2_image_io::{
    kCGImageDestinationLossyCompressionQuality, kCGImagePropertyExifDateTimeOriginal,
    kCGImagePropertyExifDictionary, kCGImagePropertyExifSubsecTimeOriginal, kCGImagePropertyGPSDictionary,
    kCGImagePropertyGPSLatitude, kCGImagePropertyGPSLatitudeRef, kCGImagePropertyGPSLongitude,
    kCGImagePropertyGPSLongitudeRef, kCGImagePropertyOrientation, kCGImagePropertyPixelHeight,
    kCGImagePropertyPixelWidth, kCGImagePropertyTIFFDictionary, kCGImagePropertyTIFFMake,
    kCGImagePropertyTIFFModel, kCGImageSourceCreateThumbnailFromImageAlways,
    kCGImageSourceCreateThumbnailFromImageIfAbsent, kCGImageSourceCreateThumbnailWithTransform,
    kCGImageSourceShouldCache, kCGImageSourceThumbnailMaxPixelSize, CGImageDestination, CGImageSource,
};

use super::model::Metadata;
use super::{Error, Result};

type Dict = CFDictionary<CFString, CFType>;

fn dict(pairs: &[(&CFString, &CFType)]) -> CFRetained<Dict> {
    let keys: Vec<&CFString> = pairs.iter().map(|(k, _)| *k).collect();
    let values: Vec<&CFType> = pairs.iter().map(|(_, v)| *v).collect();
    CFDictionary::from_slices(&keys, &values)
}

fn open(path: &Path) -> Option<CFRetained<CGImageSource>> {
    let url = CFURL::from_file_path(path)?;
    // Every file is read once per job, so caching decoded pixels only costs memory.
    let options = dict(&[(unsafe { kCGImageSourceShouldCache }, CFBoolean::new(false).as_ref())]);
    unsafe { CGImageSource::with_url(&url, Some(options.as_ref())) }
}

fn sub(d: &Dict, key: &CFString) -> Option<CFRetained<Dict>> {
    let value = d.get(key)?.downcast::<CFDictionary>().ok()?;
    Some(unsafe { CFRetained::cast_unchecked(value) })
}
fn int(d: &Dict, key: &CFString) -> Option<i64> {
    d.get(key)?.downcast::<CFNumber>().ok()?.as_i64()
}
fn float(d: &Dict, key: &CFString) -> Option<f64> {
    d.get(key)?.downcast::<CFNumber>().ok()?.as_f64()
}
fn text(d: &Dict, key: &CFString) -> Option<String> {
    Some(d.get(key)?.downcast::<CFString>().ok()?.to_string())
}

/// Reads metadata from the file headers only.
pub fn read_metadata(path: &Path) -> Option<Metadata> {
    let source = open(path)?;
    let props = unsafe { source.properties_at_index(0, None) }?;
    let props: CFRetained<Dict> = unsafe { CFRetained::cast_unchecked(props) };
    let mut meta = Metadata {
        width: int(&props, unsafe { kCGImagePropertyPixelWidth }),
        height: int(&props, unsafe { kCGImagePropertyPixelHeight }),
        orientation: int(&props, unsafe { kCGImagePropertyOrientation }),
        ..Metadata::default()
    };
    if let Some(exif) = sub(&props, unsafe { kCGImagePropertyExifDictionary }) {
        let subsec = text(&exif, unsafe { kCGImagePropertyExifSubsecTimeOriginal });
        meta.captured_at = text(&exif, unsafe { kCGImagePropertyExifDateTimeOriginal })
            .and_then(|t| exif_time(&t, subsec.as_deref()));
    }
    if let Some(tiff) = sub(&props, unsafe { kCGImagePropertyTIFFDictionary }) {
        meta.camera_make = text(&tiff, unsafe { kCGImagePropertyTIFFMake }).map(|s| s.trim().to_owned());
        meta.camera_model = text(&tiff, unsafe { kCGImagePropertyTIFFModel }).map(|s| s.trim().to_owned());
    }
    if let Some(gps) = sub(&props, unsafe { kCGImagePropertyGPSDictionary }) {
        let signed = |value: Option<f64>, reference: Option<String>, negative: &str| {
            value.map(|v| if reference.as_deref() == Some(negative) { -v } else { v })
        };
        meta.latitude = signed(
            float(&gps, unsafe { kCGImagePropertyGPSLatitude }),
            text(&gps, unsafe { kCGImagePropertyGPSLatitudeRef }),
            "S",
        );
        meta.longitude = signed(
            float(&gps, unsafe { kCGImagePropertyGPSLongitude }),
            text(&gps, unsafe { kCGImagePropertyGPSLongitudeRef }),
            "W",
        );
    }
    Some(meta)
}

/// "2026:08:27 16:01:38" + subsec "12" -> "2026-08-27T16:01:38.120".
pub fn exif_time(value: &str, subsec: Option<&str>) -> Option<String> {
    let t = chrono::NaiveDateTime::parse_from_str(value.trim(), "%Y:%m:%d %H:%M:%S").ok()?;
    let ms = subsec
        .map(|s| s.trim().chars().filter(char::is_ascii_digit).chain("000".chars()).take(3).collect::<String>())
        .and_then(|digits| digits.parse::<u32>().ok())
        .unwrap_or(0);
    Some(format!("{}.{ms:03}", t.format("%Y-%m-%dT%H:%M:%S")))
}

static VIDEO_HELPER: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Where the app keeps the `videoframe` helper (inside the app bundle).
pub fn set_video_helper(path: std::path::PathBuf) {
    let _ = VIDEO_HELPER.set(path);
}

fn video_helper() -> std::path::PathBuf {
    VIDEO_HELPER
        .get()
        .cloned()
        .or_else(|| std::env::var_os("CBA_VIDEOFRAME").map(Into::into))
        .unwrap_or_else(|| concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/videoframe").into())
}

/// What a video frame grab also tells: length and when it was filmed.
#[derive(Clone, Debug, Default)]
pub struct VideoInfo {
    pub seconds: f64,
    pub width: i64,
    pub height: i64,
    /// Local "YYYY-MM-DDTHH:MM:SS.mmm", when the file says.
    pub created: Option<String>,
    /// `created` is the camera's own clock (Sony metadata), not the file's UTC date.
    pub clock: bool,
    /// The camera model and picture profile Sony recorded, when it did.
    pub camera: Option<String>,
    pub gamma: Option<String>,
}

/// What Sony (and other XAVC cameras) record in a clip, in an XML block at
/// its end: `<CreationDate value="2026-04-05T08:02:23+01:00"/>` (the camera's
/// clock, the same one the photos' EXIF uses), `modelName="ILCE-6700"` and
/// `CaptureGammaEquation" value="s-log3-cine"`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClipMeta {
    pub created: Option<String>,
    pub camera: Option<String>,
    pub gamma: Option<String>,
}

/// Reads [`ClipMeta`] from the end of a clip, then its start; only those parts
/// are read, so an online clip is not downloaded.
pub fn clip_meta(path: &Path) -> ClipMeta {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return ClipMeta::default() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut tail = Vec::new();
    if f.seek(SeekFrom::Start(len.saturating_sub(256 << 10))).is_ok() {
        let _ = (&mut f).take(256 << 10).read_to_end(&mut tail);
    }
    let meta = parse_clip_meta(&tail);
    if meta.created.is_some() || meta.gamma.is_some() {
        return meta;
    }
    let mut head = Vec::new();
    if f.seek(SeekFrom::Start(0)).is_ok() {
        let _ = (&mut f).take(512 << 10).read_to_end(&mut head);
    }
    parse_clip_meta(&head)
}

fn parse_clip_meta(bytes: &[u8]) -> ClipMeta {
    ClipMeta {
        created: wall_time_after(bytes, b"CreationDate value=\""),
        camera: text_after(bytes, b"modelName=\""),
        gamma: text_after(bytes, b"CaptureGammaEquation\" value=\"").map(|g| g.to_ascii_lowercase()),
    }
}

fn text_after(bytes: &[u8], marker: &[u8]) -> Option<String> {
    let at = bytes.windows(marker.len()).position(|w| w == marker)? + marker.len();
    let end = bytes.get(at..)?.iter().take(64).position(|&b| b == b'"')?;
    let text = std::str::from_utf8(&bytes[at..at + end]).ok()?.trim().to_owned();
    (!text.is_empty()).then_some(text)
}

/// Writes one frame of a video (about 1 s in) to `dest` as a JPEG of at most
/// `max_px`. Reads only what it needs, so a video that lives online is not
/// downloaded whole (Google Drive serves parts of files).
pub fn video_frame(path: &Path, dest: &Path, max_px: u32) -> Result<VideoInfo> {
    video_frame_within(path, dest, max_px, None)
}

/// `video_frame`, given up after `limit` (the helper is stopped): a clip whose
/// bytes trickle in through the Google Drive app must not hold up others.
pub fn video_frame_within(path: &Path, dest: &Path, max_px: u32, limit: Option<std::time::Duration>) -> Result<VideoInfo> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = dest.with_extension(format!("{:?}.partial", std::thread::current().id()).replace(|c: char| !c.is_ascii_alphanumeric() && c != '.', ""));
    let mut child = std::process::Command::new(video_helper())
        .arg(path)
        .arg(&tmp)
        .arg(max_px.to_string())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    if let Some(limit) = limit {
        let started = std::time::Instant::now();
        loop {
            if child.try_wait()?.is_some() {
                break;
            }
            if started.elapsed() > limit {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&tmp);
                return Err(Error::Media(format!("video frame: no answer within {} s", limit.as_secs())));
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
    let out = child.wait_with_output()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if !out.status.success() || text.starts_with("error") {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::Media(format!("video frame: {text}")));
    }
    std::fs::rename(&tmp, dest)?;
    let mut parts = text.split_whitespace();
    let seconds = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let width = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let height = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    // The camera's own clock first, like a photo's EXIF time, so a clip sorts
    // between the photos taken around it. Otherwise the file's (UTC) date.
    let meta = clip_meta(path);
    let clock = meta.created.is_some();
    let created = meta.created.clone().or_else(|| {
        parts.next().filter(|v| *v != "-").and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok()).map(|t| {
            t.with_timezone(&chrono::Local).format("%Y-%m-%dT%H:%M:%S%.3f").to_string()
        })
    });
    Ok(VideoInfo { seconds, width, height, created, clock, camera: meta.camera, gamma: meta.gamma })
}

/// One exact moment of a video at full size, as a JPEG to keep (quality 0.92).
pub fn video_still(path: &Path, dest: &Path, at_seconds: f64) -> Result<VideoInfo> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = dest.with_extension("still.partial");
    let out = std::process::Command::new(video_helper())
        .arg(path)
        .arg(&tmp)
        .arg("0")
        .arg(format!("{:.3}", at_seconds.max(0.0)))
        .arg("0.92")
        .output()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if !out.status.success() || text.starts_with("error") {
        let _ = std::fs::remove_file(&tmp); // our own half-written file
        return Err(Error::Media(format!("video frame: {text}")));
    }
    std::fs::rename(&tmp, dest)?;
    let mut parts = text.split_whitespace();
    let seconds = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let width = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let height = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    Ok(VideoInfo { seconds, width, height, ..VideoInfo::default() })
}

fn wall_time_after(bytes: &[u8], marker: &[u8]) -> Option<String> {
    let at = bytes.windows(marker.len()).position(|w| w == marker)? + marker.len();
    let text = std::str::from_utf8(bytes.get(at..at + 19)?).ok()?;
    let t = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S").ok()?;
    Some(t.format("%Y-%m-%dT%H:%M:%S%.3f").to_string())
}

#[cfg(test)]
mod video_tests {
    #[test]
    fn camera_clock_is_the_wall_time() {
        let xml = b"....<Duration value=\"437\"/><CreationDate value=\"2026-04-05T08:02:23+01:00\"/><VideoFormat>";
        assert_eq!(super::wall_time_after(xml, b"CreationDate value=\"").as_deref(), Some("2026-04-05T08:02:23.000"));
        assert_eq!(super::wall_time_after(b"nothing here", b"CreationDate value=\""), None);
    }

    #[test]
    fn sony_clip_metadata() {
        let xml = br#"<CreationDate value="2026-04-05T08:02:23+01:00"/><Device manufacturer="Sony" modelName="ILCE-6700" serialNo="1"/><Item name="CaptureGammaEquation" value="s-log3-cine"/>"#;
        let m = super::parse_clip_meta(xml);
        assert_eq!(m.created.as_deref(), Some("2026-04-05T08:02:23.000"));
        assert_eq!(m.camera.as_deref(), Some("ILCE-6700"));
        assert_eq!(m.gamma.as_deref(), Some("s-log3-cine"));
        assert_eq!(super::parse_clip_meta(b"no xml"), super::ClipMeta::default());
    }
}

/// Brings down a file that lives online (iCloud Drive or Google Drive) by
/// reading it through once. Needed before ImageIO or copyfile touch it: they
/// refuse a placeholder instead of downloading it. The file is only read.
pub fn fetch_download(path: &Path) -> std::io::Result<()> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut buf = vec![0u8; 8 << 20];
    while f.read(&mut buf)? > 0 {}
    Ok(())
}

/// "Remove Download" for a file that lives online (iCloud Drive or Google
/// Drive): only this Mac's copy is dropped; the file stays online, untouched.
/// Returns whether the system accepted it.
pub fn release_download(path: &Path) -> bool {
    const SCRIPT: &str = "ObjC.import('Foundation'); function run(argv) { const err = Ref(); \
        return $.NSFileManager.defaultManager.evictUbiquitousItemAtURLError($.NSURL.fileURLWithPath(argv[0]), err) ? 'ok' : 'failed'; }";
    std::process::Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", SCRIPT])
        .arg(path)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "ok")
        .unwrap_or(false)
}

/// Moves a file to the Trash, where it can still be put back. Returns whether
/// it went.
pub fn trash(path: &Path) -> bool {
    const SCRIPT: &str = "ObjC.import('Foundation'); function run(argv) { const out = Ref(); const err = Ref(); \
        return $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), out, err) ? 'ok' : 'failed'; }";
    std::process::Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", SCRIPT])
        .arg(path)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "ok")
        .unwrap_or(false)
}

fn long_edge(image: &CGImage) -> usize {
    CGImage::width(Some(image)).max(CGImage::height(Some(image)))
}

/// A downscaled, correctly rotated image of at most `max_px` on the long edge.
/// For RAW files the embedded camera preview is used when it is big enough;
/// the RAW is only developed when it isn't.
pub fn thumbnail(path: &Path, max_px: u32, is_raw: bool) -> Result<CFRetained<CGImage>> {
    let source = open(path).ok_or_else(|| Error::Media(format!("cannot open {}", path.display())))?;
    let yes = CFBoolean::new(true);
    let size = CFNumber::new_i64(i64::from(max_px));
    let make = |develop: bool| {
        let mode = if develop {
            unsafe { kCGImageSourceCreateThumbnailFromImageAlways }
        } else {
            unsafe { kCGImageSourceCreateThumbnailFromImageIfAbsent }
        };
        let options = dict(&[
            (unsafe { kCGImageSourceCreateThumbnailWithTransform }, yes.as_ref()),
            (unsafe { kCGImageSourceThumbnailMaxPixelSize }, size.as_ref()),
            (mode, yes.as_ref()),
        ]);
        unsafe { source.thumbnail_at_index(0, Some(options.as_ref())) }
    };
    if is_raw {
        if let Some(embedded) = make(false) {
            if long_edge(&embedded) * 2 >= max_px as usize {
                return Ok(embedded);
            }
        }
    }
    make(true).ok_or_else(|| Error::Media(format!("cannot decode {}", path.display())))
}

/// Writes a JPEG atomically: a crash never leaves a half-written file in the cache.
pub fn write_jpeg(image: &CGImage, dest: &Path, quality: f64) -> Result<()> {
    write_image(image, dest, "public.jpeg", Some(quality), None)
}

fn write_image(image: &CGImage, dest: &Path, uti: &str, quality: Option<f64>, props: Option<&Dict>) -> Result<()> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Unique per writer: the background preview job and the photo page may
    // make the same preview at once; the last complete one simply wins.
    let unique = format!("{:?}-{}", std::thread::current().id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0));
    let tmp = dest.with_extension(format!("{}.partial", unique.replace(|c: char| !c.is_ascii_alphanumeric(), "")));
    let url = CFURL::from_file_path(&tmp).ok_or_else(|| Error::Media(format!("bad path {}", tmp.display())))?;
    let kind = CFString::from_str(uti);
    let destination = unsafe { CGImageDestination::with_url(&url, &kind, 1, None) }
        .ok_or_else(|| Error::Media(format!("cannot write {uti}")))?;
    let quality_number = quality.map(CFNumber::new_f64);
    let quality_dict =
        quality_number.as_ref().map(|q| dict(&[(unsafe { kCGImageDestinationLossyCompressionQuality }, q.as_ref())]));
    let properties = props.or(quality_dict.as_deref());
    unsafe { destination.add_image(image, properties.map(|p| p.as_ref())) };
    if !unsafe { destination.finalize() } {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::Media(format!("failed to encode {}", dest.display())));
    }
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

/// The image scaled to fit `max_px`, as RGBA bytes (row 0 at the top).
pub fn rgba_scaled(image: &CGImage, max_px: usize) -> Option<(usize, usize, Vec<u8>)> {
    let (w, h) = (CGImage::width(Some(image)), CGImage::height(Some(image)));
    if w == 0 || h == 0 {
        return None;
    }
    let scale = (max_px as f64 / w.max(h) as f64).min(1.0);
    let tw = ((w as f64 * scale).round() as usize).max(1);
    let th = ((h as f64 * scale).round() as usize).max(1);
    let mut rgba = vec![0u8; tw * th * 4];
    let space = CGColorSpace::new_device_rgb()?;
    // kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big: bytes land as R, G, B, A.
    let info = 1u32 | (4 << 12);
    let context = unsafe {
        CGBitmapContextCreate(rgba.as_mut_ptr().cast::<c_void>(), tw, th, 8, tw * 4, Some(&space), info)
    }?;
    CGContext::set_interpolation_quality(Some(&context), CGInterpolationQuality::High);
    let rect = CGRect { origin: CGPoint { x: 0.0, y: 0.0 }, size: CGSize { width: tw as f64, height: th as f64 } };
    CGContext::draw_image(Some(&context), rect, Some(image));
    drop(context);
    Some((tw, th, rgba))
}

/// ~25-byte ThumbHash of the image: the UI decodes it into a blurred
/// placeholder so the grid never shows empty boxes.
pub fn thumbhash(image: &CGImage) -> Option<Vec<u8>> {
    let (tw, th, rgba) = rgba_scaled(image, 100)?;
    Some(thumbhash::rgba_to_thumb_hash(tw, th, &rgba))
}

/// Decoded pixels exactly as stored in the file, with no colour management:
/// what a LUT image (HaldCLUT) needs, where every value is data, not colour.
pub struct RawPixels {
    pub width: usize,
    pub height: usize,
    bytes_per_row: usize,
    bytes_per_pixel: usize,
    sixteen: bool,
    little: bool,
    /// Byte offsets of R, G, B within a pixel (in components).
    rgb: [usize; 3],
    data: Vec<u8>,
}

impl RawPixels {
    /// RGB at (x, y), 0..1.
    pub fn rgb(&self, x: usize, y: usize) -> [f32; 3] {
        let base = y * self.bytes_per_row + x * self.bytes_per_pixel;
        let mut out = [0f32; 3];
        for (i, c) in self.rgb.iter().enumerate() {
            out[i] = if self.sixteen {
                let o = base + c * 2;
                let (a, b) = (self.data[o], self.data[o + 1]);
                let v = if self.little { u16::from_le_bytes([a, b]) } else { u16::from_be_bytes([a, b]) };
                v as f32 / 65535.0
            } else {
                self.data[base + c] as f32 / 255.0
            };
        }
        out
    }
}

pub fn raw_pixels(path: &Path) -> Result<RawPixels> {
    let source = open(path).ok_or_else(|| Error::Media(format!("cannot open {}", path.display())))?;
    let image = unsafe { source.image_at_index(0, None) }.ok_or_else(|| Error::Media(format!("cannot decode {}", path.display())))?;
    let img = Some(&*image);
    let (width, height) = (CGImage::width(img), CGImage::height(img));
    let bpc = CGImage::bits_per_component(img);
    let bpp = CGImage::bits_per_pixel(img);
    let bytes_per_row = CGImage::bytes_per_row(img);
    let info = CGImage::bitmap_info(img).0;
    let alpha = CGImage::alpha_info(img).0;
    if !(bpc == 8 || bpc == 16) || bpp < bpc {
        return Err(Error::Media(format!("unsupported pixel layout: {bpc} bits per component, {bpp} per pixel")));
    }
    let provider = CGImage::data_provider(img).ok_or_else(|| Error::Media("no pixel data".into()))?;
    let data = objc2_core_graphics::CGDataProvider::data(Some(&provider)).ok_or_else(|| Error::Media("no pixel data".into()))?.to_vec();
    let components = bpp / bpc;
    // kCGImageAlphaPremultipliedFirst, First, NoneSkipFirst put alpha before RGB.
    let alpha_first = matches!(alpha, 2 | 4 | 6) && components == 4;
    let order = info & 0x7000;
    let (sixteen, little32) = (bpc == 16, order == 2 << 12 && bpc == 8);
    let mut rgb = if components < 3 {
        // Greyscale (black-and-white HaldCLUTs): one value for all three channels.
        let g = if components == 2 && matches!(alpha, 2 | 4 | 6) { 1 } else { 0 };
        [g, g, g]
    } else if alpha_first {
        [1, 2, 3]
    } else {
        [0, 1, 2]
    };
    if little32 && components >= 3 {
        // 32-bit little endian: the whole pixel word is byte-swapped (XRGB -> BGRX).
        rgb = [components - 1 - rgb[0], components - 1 - rgb[1], components - 1 - rgb[2]];
    }
    if data.len() < bytes_per_row * height {
        return Err(Error::Media("truncated pixel data".into()));
    }
    Ok(RawPixels {
        width,
        height,
        bytes_per_row,
        bytes_per_pixel: bpp / 8,
        sixteen,
        little: sixteen && order == 1 << 12,
        rgb,
        data,
    })
}

/// Test fixtures and the synthetic-library generator: real JPEGs (optionally
/// with an EXIF capture time and camera) produced through the same ImageIO path.
pub mod fixtures {
    use super::*;

    /// A width x height image of one colour.
    pub fn solid_image(width: u32, height: u32, rgb: [u8; 3]) -> CFRetained<CGImage> {
        image(width, height, |_, _| rgb)
    }

    /// Any image from a per-pixel function, via an uncompressed BMP that ImageIO decodes.
    pub fn image(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 3]) -> CFRetained<CGImage> {
        let row = (width as usize * 3).div_ceil(4) * 4;
        let data_len = row * height as usize;
        let mut bmp = Vec::with_capacity(54 + data_len);
        bmp.extend_from_slice(b"BM");
        bmp.extend_from_slice(&((54 + data_len) as u32).to_le_bytes());
        bmp.extend_from_slice(&[0; 4]);
        bmp.extend_from_slice(&54u32.to_le_bytes());
        bmp.extend_from_slice(&40u32.to_le_bytes());
        bmp.extend_from_slice(&(width as i32).to_le_bytes());
        bmp.extend_from_slice(&(height as i32).to_le_bytes());
        bmp.extend_from_slice(&1u16.to_le_bytes());
        bmp.extend_from_slice(&24u16.to_le_bytes());
        bmp.extend_from_slice(&[0; 24]);
        for y in (0..height).rev() {
            let mut line = Vec::with_capacity(row);
            for x in 0..width {
                let [r, g, b] = pixel(x, y);
                line.extend_from_slice(&[b, g, r]);
            }
            line.resize(row, 0);
            bmp.extend_from_slice(&line);
        }
        let data = objc2_core_foundation::CFData::from_bytes(&bmp);
        let source = unsafe { CGImageSource::with_data(&data, None) }.expect("bmp source");
        unsafe { source.image_at_index(0, None) }.expect("bmp decode")
    }

    /// Writes a JPEG; `exif` is ("YYYY:MM:DD HH:MM:SS", camera model).
    pub fn write_jpeg(path: &Path, width: u32, height: u32, rgb: [u8; 3], exif: Option<(&str, &str)>) -> Result<()> {
        write_image_jpeg(&solid_image(width, height, rgb), path, exif)
    }

    /// Writes a lossless PNG (for LUT images, where every value matters).
    pub fn write_png(image: &CGImage, path: &Path) -> Result<()> {
        write_image(image, path, "public.png", None, None)
    }

    /// Writes any image as a JPEG, optionally with an EXIF capture time and camera model.
    pub fn write_image_jpeg(image: &CGImage, path: &Path, exif: Option<(&str, &str)>) -> Result<()> {
        let Some((time, model)) = exif else {
            return super::write_jpeg(image, path, 0.8);
        };
        let time = CFString::from_str(time);
        let model = CFString::from_str(model);
        let exif_dict = dict(&[(unsafe { kCGImagePropertyExifDateTimeOriginal }, time.as_ref())]);
        let tiff_dict = dict(&[(unsafe { kCGImagePropertyTIFFModel }, model.as_ref())]);
        let props = dict(&[
            (unsafe { kCGImagePropertyExifDictionary }, exif_dict.as_ref()),
            (unsafe { kCGImagePropertyTIFFDictionary }, tiff_dict.as_ref()),
        ]);
        write_image(image, path, "public.jpeg", None, Some(&props))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exif_times_become_sortable_text() {
        assert_eq!(exif_time("2026:08:27 16:01:38", Some("12")).as_deref(), Some("2026-08-27T16:01:38.120"));
        assert_eq!(exif_time("2026:08:27 16:01:38", None).as_deref(), Some("2026-08-27T16:01:38.000"));
        assert_eq!(exif_time("0000:00:00 00:00:00", None), None, "cameras without a clock write zeros");
    }

    #[test]
    fn round_trips_a_fixture_through_imageio() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shot.jpg");
        fixtures::write_jpeg(&path, 640, 480, [200, 40, 40], Some(("2026:08:27 16:01:38", "ILCE-7M4"))).unwrap();

        let meta = read_metadata(&path).unwrap();
        assert_eq!((meta.width, meta.height), (Some(640), Some(480)));
        assert_eq!(meta.captured_at.as_deref(), Some("2026-08-27T16:01:38.000"));
        assert_eq!(meta.camera_model.as_deref(), Some("ILCE-7M4"));

        let thumb = thumbnail(&path, 320, false).unwrap();
        assert_eq!(long_edge(&thumb), 320);
        let hash = thumbhash(&thumb).unwrap();
        assert!(hash.len() > 5 && hash.len() < 40, "thumbhash is compact: {} bytes", hash.len());
    }
}
