//! A "date taken" for exported JPEGs. Instagram's photo picker sorts by date
//! taken, so exports that carry times one second apart land together, in
//! carousel order, at the top of it. Only our own export files get this.

/// The JPEG with a minimal EXIF block (DateTime, DateTimeOriginal,
/// DateTimeDigitized) set to `taken` ("YYYY:MM:DD HH:MM:SS"). Returns the
/// input unchanged when it isn't a JPEG or the time isn't valid.
pub fn with_taken_time(jpeg: &[u8], taken: &str) -> Vec<u8> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 || chrono::NaiveDateTime::parse_from_str(taken, "%Y:%m:%d %H:%M:%S").is_err() {
        return jpeg.to_vec();
    }
    let mut when = taken.as_bytes().to_vec();
    when.push(0); // ASCII values end with a NUL: 20 bytes
    // TIFF block, big-endian. IFD0 at 8 (DateTime, pointer to the Exif IFD),
    // Exif IFD at 38 (DateTimeOriginal, DateTimeDigitized), the text at 68.
    let mut tiff = Vec::with_capacity(88);
    tiff.extend_from_slice(b"MM\x00\x2a");
    tiff.extend_from_slice(&8u32.to_be_bytes());
    let entry = |t: &mut Vec<u8>, tag: u16, kind: u16, count: u32, value: u32| {
        t.extend_from_slice(&tag.to_be_bytes());
        t.extend_from_slice(&kind.to_be_bytes());
        t.extend_from_slice(&count.to_be_bytes());
        t.extend_from_slice(&value.to_be_bytes());
    };
    tiff.extend_from_slice(&2u16.to_be_bytes());
    entry(&mut tiff, 0x0132, 2, 20, 68); // DateTime
    entry(&mut tiff, 0x8769, 4, 1, 38); // Exif IFD
    tiff.extend_from_slice(&0u32.to_be_bytes());
    tiff.extend_from_slice(&2u16.to_be_bytes());
    entry(&mut tiff, 0x9003, 2, 20, 68); // DateTimeOriginal
    entry(&mut tiff, 0x9004, 2, 20, 68); // DateTimeDigitized
    tiff.extend_from_slice(&0u32.to_be_bytes());
    tiff.extend_from_slice(&when);

    let mut app1 = vec![0xFF, 0xE1];
    app1.extend_from_slice(&((2 + 6 + tiff.len()) as u16).to_be_bytes());
    app1.extend_from_slice(b"Exif\x00\x00");
    app1.extend_from_slice(&tiff);

    // After the JFIF header when there is one, otherwise right after the start marker.
    let mut at = 2;
    if jpeg.len() > 6 && jpeg[2] == 0xFF && jpeg[3] == 0xE0 {
        at = 4 + u16::from_be_bytes([jpeg[4], jpeg[5]]) as usize;
        if at > jpeg.len() {
            at = 2;
        }
    }
    let mut out = Vec::with_capacity(jpeg.len() + app1.len());
    out.extend_from_slice(&jpeg[..at]);
    out.extend_from_slice(&app1);
    out.extend_from_slice(&jpeg[at..]);
    out
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn exports_carry_the_date_taken() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain.jpg");
        super::super::media::fixtures::write_jpeg(&plain, 60, 40, [10, 120, 200], None).unwrap();
        let bytes = std::fs::read(&plain).unwrap();
        let dated = super::with_taken_time(&bytes, "2026:09:28 23:10:05");
        let path = dir.path().join("dated.jpg");
        std::fs::write(&path, &dated).unwrap();
        let meta = super::super::media::read_metadata(&path).expect("still a readable JPEG");
        assert_eq!(meta.captured_at.as_deref().map(|s| &s[..19]), Some("2026-09-28T23:10:05"));
        assert_eq!(super::with_taken_time(&bytes, "not a time"), bytes, "a bad time changes nothing");
    }
}
