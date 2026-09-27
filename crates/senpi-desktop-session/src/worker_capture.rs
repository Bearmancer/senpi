//! `capture`: backend image -> capture caps -> PNG, recorded as the target's
//! latest frame. The byte budget (JPEG / artifact-only) lands with todo 21.

use senpi_desktop_core::error::CoreResult;
use senpi_desktop_core::frame::{apply_capture_caps, encode_png};
use senpi_desktop_core::protocol_params::CaptureParams;
use senpi_desktop_core::types::{CaptureMode, CaptureResult, Target};

use crate::request::Response;
use crate::worker::Worker;

impl Worker {
    pub(crate) fn capture(&mut self, params: &CaptureParams) -> CoreResult<Response> {
        let target = Target::parse(&params.target);
        let caps = match (&params.caps, &self.options) {
            (Some(caps), _) => caps.clone(),
            (None, Some(options)) => options.capture_caps.clone(),
            (None, None) => Default::default(),
        };
        let (image, mut geometry) = self.backend()?.capture(&target, &caps)?;
        let (source_width, source_height) = image.dimensions();
        let image = apply_capture_caps(image, &mut geometry, &caps)?;
        let (width, height) = image.dimensions();
        let png = encode_png(image)?;
        let frame_id = self.frames.record(&target, geometry);
        self.refresh_capabilities();
        Ok(Response::Capture(CaptureResult {
            mode: CaptureMode::InlinePng,
            data: Some(base64(&png)),
            mime_type: Some("image/png".to_owned()),
            artifact_path: None,
            width,
            height,
            source_width,
            source_height,
            scale: f64::from(width) / f64::from(source_width),
            target: target.key().to_owned(),
            frame_id,
            note: None,
        }))
    }
}

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard padded base64 (RFC 4648 section 4).
fn base64(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let [a, b, c] = [0, 1, 2].map(|index| chunk.get(index).copied().unwrap_or(0));
        let group = u32::from_be_bytes([0, a, b, c]);
        let sextets = [18, 12, 6, 0].map(|shift| char::from(ALPHABET[usize::from(sextet(group, shift))]));
        let kept = chunk.len() + 1;
        encoded.extend(sextets.iter().take(kept));
        encoded.extend(std::iter::repeat_n('=', 4 - kept));
    }
    encoded
}

/// The six bits of `group` starting at bit `shift`.
fn sextet(group: u32, shift: u32) -> u8 {
    // Masked to six bits, so the value always fits a `u8`.
    u8::try_from((group >> shift) & 0x3f).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn base64_matches_the_rfc_4648_vectors() {
        let vectors = [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ];
        for (input, expected) in vectors {
            assert_eq!(base64(input.as_bytes()), expected, "base64({input:?})");
        }
    }

    #[test]
    fn base64_uses_the_standard_alphabet_for_high_bits() {
        assert_eq!(base64(&[0xfb, 0xff, 0xbf]), "+/+/");
    }
}
