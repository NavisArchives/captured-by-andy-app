use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

/// Bytes hashed from each end of the file.
const EDGE: u64 = 64 * 1024;

/// Quick content fingerprint: BLAKE3 over the size plus the first and last
/// 64 KiB. Reads at most 128 KiB however large the file is, yet still tells
/// apart files that merely share a name - enough to follow a file that was
/// moved or renamed. A full-content hash can be added as a later stage.
pub fn quick(path: &Path, size: u64) -> io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(&size.to_le_bytes());

    let mut buf = vec![0u8; EDGE as usize];
    let n = read_up_to(&mut file, &mut buf)?;
    hasher.update(&buf[..n]);

    if size > EDGE {
        file.seek(SeekFrom::Start(EDGE.max(size.saturating_sub(EDGE))))?;
        let n = read_up_to(&mut file, &mut buf)?;
        hasher.update(&buf[..n]);
    }
    Ok(format!("q1:{}", hasher.finalize().to_hex()))
}

fn read_up_to(file: &mut File, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let p = dir.path().join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn same_content_same_fingerprint_regardless_of_name() {
        let d = tempfile::tempdir().unwrap();
        let a = write(&d, "a.jpg", &[7u8; 300_000]);
        let b = write(&d, "renamed.jpg", &[7u8; 300_000]);
        assert_eq!(quick(&a, 300_000).unwrap(), quick(&b, 300_000).unwrap());
    }

    #[test]
    fn a_change_at_either_end_changes_it() {
        let d = tempfile::tempdir().unwrap();
        let base = vec![1u8; 300_000];
        let mut head = base.clone();
        head[10] = 9;
        let mut tail = base.clone();
        tail[299_990] = 9;
        let fp = |name, bytes: &[u8]| quick(&write(&d, name, bytes), bytes.len() as u64).unwrap();
        let original = fp("base", &base);
        assert_ne!(original, fp("head", &head));
        assert_ne!(original, fp("tail", &tail));
    }

    #[test]
    fn small_files_are_hashed_whole() {
        let d = tempfile::tempdir().unwrap();
        let mut bytes = vec![3u8; 100_000];
        let a = quick(&write(&d, "a", &bytes), 100_000).unwrap();
        bytes[80_000] = 4; // past the first 64 KiB: the second read must cover it
        let b = quick(&write(&d, "b", &bytes), 100_000).unwrap();
        assert_ne!(a, b);
    }
}
