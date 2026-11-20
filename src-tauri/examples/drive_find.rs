//! Looks files up by exact name through Drive's search (files.list), the same
//! index rclone lists from. `drive_find <name>...`
use captured_by_andy_lib::library::gdrive;
fn main() {
    for n in std::env::args().skip(1) {
        match gdrive::find_by_name(&n) {
            Some((id, size)) => println!("{n}\tlisted\t{id}\t{size}"),
            None => println!("{n}\tNOT LISTED"),
        }
    }
}
