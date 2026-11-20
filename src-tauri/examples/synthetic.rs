//! Builds a synthetic photo library and indexes it, to check the app at a
//! realistic scale without touching a real archive.
//!
//!     cargo run --example synthetic -- <data-dir> [photo-count]
//!
//! Then start the app with CBA_DATA_DIR=<data-dir> to browse it.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use captured_by_andy_lib::library::{db::Db, media, photos, scan, sources, thumbs};

const PER_SHOOT: usize = 150;
const PLACES: &[&str] = &["Brussels", "Antwerp", "Ghent", "Pai", "Bangkok", "Chiang Mai", "Studio", "Amsterdam"];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let data = Path::new(args.get(1).expect("usage: synthetic <data-dir> [count]"));
    let count: usize = args.get(2).and_then(|n| n.parse().ok()).unwrap_or(20_000);
    let library = data.join("SyntheticLibrary");

    let t = Instant::now();
    let made = generate(&library, count);
    println!("generate  {made:>6} new files        {:>8.1?}", t.elapsed());

    let db = Db::open(&data.join("library.db")).unwrap();
    let source = sources::add(&db, &library).unwrap();
    let never = AtomicBool::new(false);

    let t = Instant::now();
    let first = scan::scan_source(&db, &source.id, &media::read_metadata, &never, |_| {}).unwrap();
    println!(
        "scan      {:>6} files, {} added, {} paired  {:>8.1?}",
        first.discovered, first.added, first.paired, t.elapsed()
    );

    let t = Instant::now();
    let again = scan::scan_source(&db, &source.id, &media::read_metadata, &never, |_| {}).unwrap();
    println!("rescan    {:>6} unchanged, {} added     {:>8.1?}", again.unchanged, again.added, t.elapsed());

    let cache = thumbs::Cache::new(data.join("cache")).unwrap();
    let pending = thumbs::pending(&db, 1_000_000).unwrap();
    let t = Instant::now();
    let workers = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).max(1);
    std::thread::scope(|s| {
        for chunk in pending.chunks(pending.len().div_ceil(workers).max(1)) {
            let (db, cache) = (&db, &cache);
            s.spawn(move || {
                for id in chunk {
                    thumbs::make_thumbnail(db, cache, id).unwrap();
                }
            });
        }
    });
    let per = t.elapsed().as_secs_f64() * 1000.0 / pending.len().max(1) as f64;
    println!("thumbs    {:>6} on {workers} threads ({per:.1} ms each) {:>8.1?}", pending.len(), t.elapsed());

    let total = photos::counts(&db, &photos::Query::default()).unwrap().all;
    for offset in [0, total / 2, total.saturating_sub(200)] {
        let t = Instant::now();
        let rows = photos::list(&db, &photos::Query::default(), offset, 200).unwrap();
        println!("list      200 rows at offset {offset:>6}         {:>8.1?} ({} rows)", t.elapsed(), rows.len());
    }
    let t = Instant::now();
    let counts = photos::counts(&db, &photos::Query::default()).unwrap();
    println!("counts    {counts:?}  {:?}", t.elapsed());
}

/// JPEGs in dated shoot folders with EXIF capture times; every 8th photo also
/// gets a fake RAW twin so RAW+JPEG pairing is exercised. Existing files are kept.
fn generate(root: &Path, count: usize) -> usize {
    // Painting pixels is the slow part, so render 64 looks x 2 orientations
    // once. Every file still has unique bytes: its EXIF capture time differs.
    const LOOKS: usize = 64;
    let base: Vec<_> = (0..LOOKS * 2)
        .map(|n| {
            let (w, h) = if n % 2 == 1 { (320, 480) } else { (480, 320) };
            let hue = (n / 2) as f32 * (360.0 / LOOKS as f32);
            let (a, b) = (hsv(hue, 0.55, 0.85), hsv((hue + 40.0) % 360.0, 0.7, 0.25));
            media::fixtures::image(w, h, |x, y| {
                let t = (x as f32 / w as f32 * 0.4 + y as f32 / h as f32 * 0.6).min(1.0);
                [0, 1, 2].map(|c| (a[c] as f32 * (1.0 - t) + b[c] as f32 * t) as u8)
            })
        })
        .collect();
    let start = SystemTime::now() - Duration::from_secs(400 * 86_400);
    let mut made = 0;
    for i in 0..count {
        let shoot = i / PER_SHOOT;
        let day = start + Duration::from_secs(shoot as u64 * 2 * 86_400);
        let when = day + Duration::from_secs(10 * 3600 + (i % PER_SHOOT) as u64 * 20);
        let secs = when.duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
        let dt = chrono::DateTime::from_timestamp(secs, 0).unwrap().naive_utc();
        let folder = root.join(format!("{} {}", dt.format("%Y-%m-%d"), PLACES[shoot % PLACES.len()]));
        let jpg = folder.join(format!("IMG_{:05}.JPG", i));
        if jpg.exists() {
            continue;
        }
        std::fs::create_dir_all(&folder).unwrap();
        let look = (shoot * 7 + (i % PER_SHOOT) / 12) % LOOKS;
        let image = &base[look * 2 + usize::from(i % 5 == 0)];
        let exif = dt.format("%Y:%m:%d %H:%M:%S").to_string();
        media::fixtures::write_image_jpeg(image, &jpg, Some((&exif, "ILCE-7M4"))).unwrap();
        set_mtime(&jpg, when);
        if i % 8 == 0 {
            let raw = jpg.with_extension("ARW");
            std::fs::write(&raw, format!("synthetic raw {i}").repeat(64)).unwrap();
            set_mtime(&raw, when);
        }
        made += 1;
    }
    made
}

fn set_mtime(path: &Path, t: SystemTime) {
    std::fs::File::options().append(true).open(path).unwrap().set_modified(t).unwrap();
}

fn hsv(h: f32, s: f32, v: f32) -> [u8; 3] {
    let c = v * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let (r, g, b) = match (h / 60.0) as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = v - c;
    [r, g, b].map(|n| ((n + m) * 255.0) as u8)
}
