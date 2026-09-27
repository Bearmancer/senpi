//! Pointer and keyboard requests. Coordinates are pixels of the target's
//! latest capture and map through its frame to global logical points.

use senpi_desktop_core::backend::{DeliveryMode, PointerEvent};
use senpi_desktop_core::error::CoreResult;
use senpi_desktop_core::frame::FrameGeometry;
use senpi_desktop_core::keys::parse_keys;
use senpi_desktop_core::protocol_params::{
    DragParams, KeyChordParams, PointParams, ScrollParams, TypeTextParams,
};
use senpi_desktop_core::types::{DesktopWindow, PointerOptions, Target};

use crate::pointer::ParsedPointerOptions;
use crate::request::Response;
use crate::worker::Worker;

impl Worker {
    /// The latest frame of `target` plus, for a window, its current geometry
    /// (a resize since capture fails `InvalidCoordinateFrame`).
    fn frame_for(
        &mut self,
        target: &Target,
        frame_id: Option<&str>,
    ) -> CoreResult<(FrameGeometry, Option<DesktopWindow>)> {
        let frame = self.frames.latest(target, frame_id)?;
        let current = match target {
            Target::Window(_) => Some(self.window(target)?),
            Target::Desktop => None,
        };
        Ok((frame, current))
    }

    fn pointer(
        &mut self,
        target: &Target,
        event: PointerEvent,
        frame: &FrameGeometry,
        mode: DeliveryMode,
    ) -> CoreResult<Response> {
        self.backend()?.pointer(target, event, frame, mode)?;
        Ok(Response::Unit)
    }

    pub(crate) fn click(&mut self, params: &PointParams) -> CoreResult<Response> {
        let options = ParsedPointerOptions::parse(params.opts.as_ref())?;
        let target = Target::parse(&params.target);
        let (frame, current) = self.frame_for(&target, params.frame_id.as_deref())?;
        let (x, y) = frame.map_point(params.x, params.y, current.as_ref())?;
        let event = PointerEvent::Click {
            x,
            y,
            button: options.button,
            count: options.count,
            modifiers: options.modifiers,
        };
        self.pointer(&target, event, &frame, options.mode)
    }

    pub(crate) fn move_mouse(&mut self, params: &PointParams) -> CoreResult<Response> {
        let mode = delivery(params.opts.as_ref())?;
        let target = Target::parse(&params.target);
        let (frame, current) = self.frame_for(&target, params.frame_id.as_deref())?;
        let (x, y) = frame.map_point(params.x, params.y, current.as_ref())?;
        self.pointer(&target, PointerEvent::Move { x, y }, &frame, mode)
    }

    pub(crate) fn drag(&mut self, params: &DragParams) -> CoreResult<Response> {
        let options = ParsedPointerOptions::parse(params.opts.as_ref())?;
        let target = Target::parse(&params.target);
        let (frame, current) = self.frame_for(&target, params.frame_id.as_deref())?;
        let path = params
            .path
            .iter()
            .map(|point| frame.map_point(point.x, point.y, current.as_ref()))
            .collect::<CoreResult<Vec<_>>>()?;
        let event = PointerEvent::Drag {
            path,
            button: options.button,
            modifiers: options.modifiers,
        };
        self.pointer(&target, event, &frame, options.mode)
    }

    pub(crate) fn scroll(&mut self, params: &ScrollParams) -> CoreResult<Response> {
        let mode = delivery(params.opts.as_ref())?;
        let target = Target::parse(&params.target);
        let (frame, current) = self.frame_for(&target, params.frame_id.as_deref())?;
        let (x, y) = frame.map_point(params.x, params.y, current.as_ref())?;
        let event = PointerEvent::Scroll {
            x,
            y,
            dx: params.dx,
            dy: params.dy,
        };
        self.pointer(&target, event, &frame, mode)
    }

    pub(crate) fn type_text(&mut self, params: &TypeTextParams) -> CoreResult<Response> {
        let mode = delivery(params.opts.as_ref())?;
        let target = Target::parse(&params.target);
        self.backend()?.type_text(&target, &params.text, mode)?;
        Ok(Response::Unit)
    }

    pub(crate) fn key_chord(&mut self, params: &KeyChordParams) -> CoreResult<Response> {
        let keys = parse_keys(&params.keys)?;
        let mode = delivery(params.opts.as_ref())?;
        let target = Target::parse(&params.target);
        self.backend()?.key_chord(&target, &keys, mode)?;
        Ok(Response::Unit)
    }
}

/// Only the delivery mode matters for these requests, but malformed options
/// still fail like they do for a click.
fn delivery(options: Option<&PointerOptions>) -> CoreResult<DeliveryMode> {
    ParsedPointerOptions::parse(options).map(|options| options.mode)
}
