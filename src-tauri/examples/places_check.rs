//! Read-only: what "Find places" would propose for a trip (names left blank).
//!   cargo run --example places_check -- <library dir> <trip dir>
use captured_by_andy_lib::library::{db::Db, places};

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let db = Db::open(&std::path::Path::new(&a[0]).join("library.db")).expect("library");
    let p = places::propose(&db, &a[1], &|_| None).expect("propose");
    println!("loose {} (located {}), elsewhere {}", p.loose, p.loose_located, p.elsewhere);
    for pl in &p.places {
        println!("{:>5} photos ({} located) {:<12} existing={} centre {:.2},{:.2} probes {:?}", pl.photos, pl.located, pl.name, pl.existing, pl.lat, pl.lon, pl.probes);
    }
}
