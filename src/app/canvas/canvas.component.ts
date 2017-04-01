import * as _ from 'lodash';
import * as $ from 'jquery';
import {
  Component, AfterViewInit, OnDestroy, ElementRef, ViewChild,
  Input, ViewChildren, QueryList, ChangeDetectionStrategy
} from '@angular/core';
import {
  Path, SubPath, Command, ProjectionOntoPath, HitResult
} from '../scripts/paths';
import {
  PathLayer, ClipPathLayer,
  VectorLayer, GroupLayer, Layer
} from '../scripts/layers';
import { CanvasType } from '../CanvasType';
import { Point, Matrix, MathUtil, ColorUtil } from '../scripts/common';
import {
  AnimatorService,
  CanvasResizeService,
  AppModeService, AppMode,
  SelectionService, SelectionType,
  StateService, MorphabilityStatus,
  HoverService, HoverType, Hover,
  SettingsService,
} from '../services';
import { CanvasRulerDirective } from './canvasruler.directive';
import { Observable } from 'rxjs/Observable';
import { Subscription } from 'rxjs/Subscription';

// TODO: need to update this value... doesn't work for large viewports very well
const MIN_SNAP_THRESHOLD = 1.5;
const DRAG_TRIGGER_TOUCH_SLOP = 1;
const SPLIT_POINT_RADIUS_FACTOR = 0.8;
const SELECTED_POINT_RADIUS_FACTOR = 1.25;
const POINT_BORDER_FACTOR = 1.075;
const DISABLED_ALPHA = 0.38;

// Canvas margin in css pixels.
export const CANVAS_MARGIN = 36;

// Default viewport size in viewport pixels.
export const DEFAULT_VIEWPORT_SIZE = 24;

// The line width of a selection in css pixels.
const SELECTION_LINE_WIDTH = 6;

// The line width of a highlight in css pixels.
const HIGHLIGHT_LINE_WIDTH = 4;

const NORMAL_POINT_COLOR = '#2962FF'; // Blue A400
const SPLIT_POINT_COLOR = '#E65100'; // Orange 900

const POINT_BORDER_COLOR = '#000';
const POINT_TEXT_COLOR = '#fff';
const SELECTION_OUTER_COLOR = '#fff';
const SELECTION_INNER_COLOR = '#2196f3';

type Context = CanvasRenderingContext2D;

@Component({
  selector: 'app-canvas',
  templateUrl: './canvas.component.html',
  styleUrls: ['./canvas.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CanvasComponent implements AfterViewInit, OnDestroy {
  @Input() canvasType: CanvasType;
  @ViewChild('canvasContainer') private canvasContainerRef: ElementRef;
  @ViewChild('renderingCanvas') private renderingCanvasRef: ElementRef;
  @ViewChild('overlayCanvas') private overlayCanvasRef: ElementRef;
  @ViewChildren(CanvasRulerDirective) canvasRulers: QueryList<CanvasRulerDirective>;

  private canvasContainer: JQuery;
  private renderingCanvas: JQuery;
  private overlayCanvas: JQuery;
  private offscreenLayerCanvas: JQuery;
  private offscreenSubPathCanvas: JQuery;
  private renderingCtx: Context;
  private overlayCtx: Context;
  private offscreenLayerCtx: Context;
  private offscreenSubPathCtx: Context;

  private isViewInit: boolean;
  private cssContainerWidth = 1;
  private cssContainerHeight = 1;
  private vlSize = { width: DEFAULT_VIEWPORT_SIZE, height: DEFAULT_VIEWPORT_SIZE };
  private cssScale: number;
  private attrScale: number;
  private currentHoverPreviewPath: Path;

  // If present, then the user is in selection mode and a
  // mouse gesture is currently in progress.
  private pointDragger: PointDragger | undefined;

  // If true, then the user is in add points mode and a mouse
  // down event occurred close enough to the path to allow a
  // a point to be created on the next mouse up event (assuming
  // the mouse's location is still within range of the path).
  private shouldPerformActionOnMouseUp = false;

  // The last known location of the mouse.
  private lastKnownMouseLocation: Point | undefined;
  private initialFilledSubPathProjOntoPath: ProjectionOntoPath | undefined;

  // TODO: use this somehow in the UI?
  private disabledSubPathIndices: number[] = [];

  private readonly subscriptions: Subscription[] = [];

  constructor(
    private readonly elementRef: ElementRef,
    private readonly appModeService: AppModeService,
    private readonly canvasResizeService: CanvasResizeService,
    private readonly hoverService: HoverService,
    private readonly stateService: StateService,
    private readonly animatorService: AnimatorService,
    private readonly selectionService: SelectionService,
    private readonly settingsService: SettingsService,
  ) { }

  ngAfterViewInit() {
    this.isViewInit = true;
    this.canvasContainer = $(this.canvasContainerRef.nativeElement);
    this.renderingCanvas = $(this.renderingCanvasRef.nativeElement);
    this.overlayCanvas = $(this.overlayCanvasRef.nativeElement);
    this.offscreenLayerCanvas = $(document.createElement('canvas'));
    this.offscreenSubPathCanvas = $(document.createElement('canvas'));
    const getCtxFn = (canvas: JQuery) => {
      return (canvas.get(0) as HTMLCanvasElement).getContext('2d');
    };
    this.renderingCtx = getCtxFn(this.renderingCanvas);
    this.overlayCtx = getCtxFn(this.overlayCanvas);
    this.offscreenLayerCtx = getCtxFn(this.offscreenLayerCanvas);
    this.offscreenSubPathCtx = getCtxFn(this.offscreenSubPathCanvas);
    this.subscriptions.push(
      this.stateService.getVectorLayerObservable(this.canvasType)
        .subscribe(vl => {
          const newWidth = vl ? vl.width : DEFAULT_VIEWPORT_SIZE;
          const newHeight = vl ? vl.height : DEFAULT_VIEWPORT_SIZE;
          const didSizeChange =
            this.vlSize.width !== newWidth || this.vlSize.height !== newHeight;
          this.vlSize = { width: newWidth, height: newHeight };
          if (didSizeChange) {
            this.resizeAndDraw();
          } else {
            this.draw();
          }
        }));
    this.subscriptions.push(
      this.canvasResizeService.asObservable()
        .subscribe(size => {
          const oldWidth = this.cssContainerWidth;
          const oldHeight = this.cssContainerHeight;
          this.cssContainerWidth = Math.max(1, size.width - CANVAS_MARGIN * 2);
          this.cssContainerHeight = Math.max(1, size.height - CANVAS_MARGIN * 2);
          if (this.cssContainerWidth !== oldWidth
            || this.cssContainerHeight !== oldHeight) {
            this.resizeAndDraw();
          }
        }));
    if (this.canvasType === CanvasType.Preview) {
      // Preview canvas specific setup.
      const interpolatePreview = () => {
        const fraction = this.animatorService.getAnimatedValue();
        const startPathLayer = this.stateService.getActivePathLayer(CanvasType.Start);
        const previewPathLayer = this.stateService.getActivePathLayer(CanvasType.Preview);
        const endPathLayer = this.stateService.getActivePathLayer(CanvasType.End);
        if (startPathLayer && previewPathLayer && endPathLayer
          && startPathLayer.isMorphableWith(endPathLayer)) {
          // Note that there is no need to broadcast layer state changes
          // for the preview canvas.
          previewPathLayer.interpolate(startPathLayer, endPathLayer, fraction);
        }
        const startGroupLayer = this.stateService.getActiveRotationLayer(CanvasType.Start);
        const previewGroupLayer = this.stateService.getActiveRotationLayer(CanvasType.Preview);
        const endGroupLayer = this.stateService.getActiveRotationLayer(CanvasType.End);
        if (startGroupLayer && previewGroupLayer && endGroupLayer) {
          previewGroupLayer.interpolate(startGroupLayer, endGroupLayer, fraction);
        }
        const startVectorLayer = this.stateService.getVectorLayer(CanvasType.Start);
        const previewVectorLayer = this.stateService.getVectorLayer(CanvasType.Preview);
        const endVectorLayer = this.stateService.getVectorLayer(CanvasType.End);
        if (startVectorLayer && previewVectorLayer && endVectorLayer) {
          previewVectorLayer.interpolate(startVectorLayer, endVectorLayer, fraction);
        }
        this.draw();
      };
      this.subscribeTo(
        this.stateService.getActivePathIdObservable(this.canvasType),
        () => interpolatePreview());
      this.subscribeTo(
        this.animatorService.getAnimatedValueObservable(),
        () => interpolatePreview());
      this.subscribeTo(this.settingsService.getSettingsObservable());
      this.subscribeTo(this.stateService.getMorphabilityStatusObservable());
    } else {
      // Non-preview canvas specific setup.
      this.subscribeTo(this.stateService.getActivePathIdObservable(this.canvasType));
      this.subscribeTo(this.selectionService.asObservable(), () => this.drawOverlays());
      this.subscribeTo(
        this.appModeService.asObservable(),
        () => {
          this.selectionService.reset();
          this.hoverService.reset();
          this.pointDragger = undefined;
          this.shouldPerformActionOnMouseUp = false;
          this.lastKnownMouseLocation = undefined;
          this.initialFilledSubPathProjOntoPath = undefined;
          this.draw();
        });
      const updateCurrentHoverFn = (hover: Hover | undefined) => {
        let previewPath: Path = undefined;
        if (this.shouldDrawLayers && hover) {
          // If the user is hovering over the inspector split button, then build
          // a snapshot of what the path would look like after the action
          // and display the result.
          const mutator = this.activePath.mutate();
          const { subIdx, cmdIdx } = hover.index;
          switch (hover.type) {
            case HoverType.Split:
              previewPath = mutator.splitCommandInHalf(subIdx, cmdIdx).build();
              break;
            case HoverType.Unsplit:
              previewPath = mutator.unsplitCommand(subIdx, cmdIdx).build();
              break;
            case HoverType.Reverse:
              previewPath = mutator.reverseSubPath(subIdx).build();
              break;
            case HoverType.ShiftForward:
              previewPath = mutator.shiftSubPathForward(subIdx).build();
              break;
            case HoverType.ShiftBack:
              previewPath = mutator.shiftSubPathBack(subIdx).build();
              break;
          }
        }
        this.currentHoverPreviewPath = previewPath;
        this.drawOverlays();
      };
      this.subscribeTo(
        this.hoverService.asObservable(),
        hover => {
          if (!hover) {
            // Clear the current hover.
            updateCurrentHoverFn(undefined);
            return;
          }
          if (hover.source !== this.canvasType
            && hover.type !== HoverType.Command) {
            updateCurrentHoverFn(undefined);
            return;
          }
          updateCurrentHoverFn(hover);
        });
    }
    this.resizeAndDraw();
  }

  ngOnDestroy() {
    this.subscriptions.forEach(s => s.unsubscribe());
  }

  private subscribeTo<T>(
    observable: Observable<T>,
    callbackFn: (t?: T) => void = () => this.draw()) {

    this.subscriptions.push(observable.subscribe(callbackFn));
  }

  private get vectorLayer() {
    return this.stateService.getVectorLayer(this.canvasType);
  }

  private get activePathId() {
    return this.stateService.getActivePathId(this.canvasType);
  }

  private get activePathLayer() {
    return this.activePathId
      ? this.stateService.getActivePathLayer(this.canvasType)
      : undefined;
  }

  private get activePath() {
    return this.activePathId
      ? this.stateService.getActivePathLayer(this.canvasType).pathData
      : undefined;
  }

  private get shouldDrawLayers() {
    return this.vectorLayer && this.activePathId;
  }

  private get currentHover() {
    return this.hoverService.getHover();
  }

  private get appMode() {
    return this.appModeService.getAppMode();
  }

  private get shouldDisableLayer() {
    return this.canvasType === CanvasType.Preview
      && this.stateService.getMorphabilityStatus() !== MorphabilityStatus.Morphable;
  }

  private get shouldLabelPoints() {
    return this.canvasType !== CanvasType.Preview
      || this.settingsService.shouldLabelPoints();
  }

  private get shouldProcessMouseEvents() {
    return this.canvasType !== CanvasType.Preview && this.activePathId;
  }

  private get transformsForActiveLayer() {
    return getTransformsForLayer(this.vectorLayer, this.activePathId);
  }

  private get smallPointRadius() {
    return this.largePointRadius / 3;
  }

  private get largePointRadius() {
    const size = Math.min(this.cssContainerWidth, this.cssContainerHeight);
    return (size / 50) / Math.max(2, this.cssScale);
  }

  private get highlightLineWidth() {
    return HIGHLIGHT_LINE_WIDTH / this.cssScale;
  }

  // private showPenCursor() {
  //   this.canvas.css({ cursor: 'url(/assets/penaddcursorsmall.png) 5 0, auto' });
  // }

  // private showSelectCursor() {
  //   this.canvas.css({ cursor: 'url(/assets/cursorpointselectsmall.png) auto' });
  // }

  // private resetCursor() {
  //   this.canvas.css({ cursor: '' });
  // }

  // Scale the canvas so that everything from this point forward is drawn
  // in terms of the SVG's viewport coordinates.
  private setupCtxWithViewportCoords = (ctx: Context) => {
    ctx.scale(this.attrScale, this.attrScale);
    ctx.clearRect(0, 0, this.vlSize.width, this.vlSize.height);
  }

  private drawTranslucentOffscreenCtx(
    ctx: Context,
    offscreenCtx: Context,
    alpha: number) {

    ctx.save();
    ctx.globalAlpha = alpha;
    // Bring the canvas back to its original coordinates before
    // drawing the offscreen canvas contents.
    ctx.scale(1 / this.attrScale, 1 / this.attrScale);
    ctx.drawImage(offscreenCtx.canvas, 0, 0);
    ctx.restore();
  }

  /**
   * Converts a mouse point's CSS coordinates into vector layer viewport coordinates.
   */
  private mouseEventToPoint(event: MouseEvent) {
    const canvasOffset = this.canvasContainer.offset();
    const x = (event.pageX - canvasOffset.left) / this.cssScale;
    const y = (event.pageY - canvasOffset.top) / this.cssScale;
    return new Point(x, y);
  }

  /**
   * Sends a signal that the canvas rulers should be redrawn.
   */
  private showRuler(event: MouseEvent) {
    const canvasOffset = this.canvasContainer.offset();
    const x = (event.pageX - canvasOffset.left) / Math.max(1, this.cssScale);
    const y = (event.pageY - canvasOffset.top) / Math.max(1, this.cssScale);
    this.canvasRulers.forEach(r => r.showMouse(new Point(_.round(x), _.round(y))));
  }

  /**
   * Resizes the canvas and redraws all content.
   */
  private resizeAndDraw() {
    if (!this.isViewInit) {
      return;
    }
    const { width: vlWidth, height: vlHeight } = this.vlSize;
    const vectorAspectRatio = vlWidth / vlHeight;
    const containerAspectRatio = this.cssContainerWidth / this.cssContainerHeight;

    // The 'cssScale' represents the number of CSS pixels per SVG viewport pixel.
    if (vectorAspectRatio > containerAspectRatio) {
      this.cssScale = this.cssContainerWidth / vlWidth;
    } else {
      this.cssScale = this.cssContainerHeight / vlHeight;
    }

    // The 'attrScale' represents the number of physical pixels per SVG viewport pixel.
    this.attrScale = this.cssScale * devicePixelRatio;

    const canvases = [
      this.canvasContainer,
      this.renderingCanvas,
      this.overlayCanvas,
      this.offscreenLayerCanvas,
      this.offscreenSubPathCanvas,
    ];
    const cssWidth = vlWidth * this.cssScale;
    const cssHeight = vlHeight * this.cssScale;
    canvases.forEach(canvas => {
      canvas
        .attr({
          width: cssWidth * devicePixelRatio,
          height: cssHeight * devicePixelRatio,
        })
        .css({
          width: cssWidth,
          height: cssHeight,
        });
    });

    this.draw();
    this.canvasRulers.forEach(r => r.draw());
  }

  /**
   * Redraws all content.
   */
  private draw() {
    if (!this.isViewInit) {
      return;
    }

    this.renderingCtx.save();
    this.setupCtxWithViewportCoords(this.renderingCtx);

    const layerAlpha = this.vectorLayer ? this.vectorLayer.alpha : 1;
    const currentAlpha = (this.shouldDisableLayer ? DISABLED_ALPHA : 1) * layerAlpha;
    if (currentAlpha < 1) {
      this.offscreenLayerCtx.save();
      this.setupCtxWithViewportCoords(this.offscreenLayerCtx);
    }

    // If the canvas is disabled, draw the layer to an offscreen canvas
    // so that we can draw it translucently w/o affecting the rest of
    // the layer's appearance.
    const layerCtx = currentAlpha < 1 ? this.offscreenLayerCtx : this.renderingCtx;
    if (this.shouldDrawLayers) {
      const hasDisabledSubPaths = !!this.disabledSubPathIndices.length;
      const subPathCtx = hasDisabledSubPaths ? this.offscreenSubPathCtx : layerCtx;
      if (hasDisabledSubPaths) {
        subPathCtx.save();
        this.setupCtxWithViewportCoords(subPathCtx);
      }

      // Draw any disabled subpaths.
      this.drawPaths(subPathCtx, layer => {
        if (layer.id !== this.activePathId) {
          return [];
        }
        return _.flatMap(layer.pathData.getSubPaths() as SubPath[],
          (subPath, subIdx) => {
            return this.disabledSubPathIndices.indexOf(subIdx) >= 0
              ? subPath.getCommands() as Command[] : [];
          });
      });
      if (hasDisabledSubPaths) {
        this.drawTranslucentOffscreenCtx(layerCtx, subPathCtx, DISABLED_ALPHA);
        subPathCtx.restore();
      }

      // Draw any enabled subpaths.
      this.drawPaths(layerCtx, layer => {
        if (layer.id !== this.activePathId) {
          return [];
        }
        return _.flatMap(layer.pathData.getSubPaths() as SubPath[],
          (subPath, subIdx) => {
            return this.disabledSubPathIndices.indexOf(subIdx) >= 0
              ? [] : subPath.getCommands() as Command[];
          });
      });
    }

    if (currentAlpha < 1) {
      this.drawTranslucentOffscreenCtx(
        this.renderingCtx, this.offscreenLayerCtx, currentAlpha);
      this.offscreenLayerCtx.restore();
    }
    this.renderingCtx.restore();

    this.drawOverlays();
  }

  // Draws any PathLayers to the canvas.
  private drawPaths(
    ctx: Context,
    extractDrawingCommandsFn: (layer: PathLayer) => ReadonlyArray<Command>,
  ) {
    this.vectorLayer.walk(layer => {
      if (layer instanceof ClipPathLayer) {
        // TODO: our SVG importer doesn't import clip paths... so this will never happen (yet)
        const transforms = getTransformsForLayer(this.vectorLayer, layer.id);
        executeCommands(ctx, layer.pathData.getCommands(), transforms);
        ctx.clip();
        return;
      }
      if (!(layer instanceof PathLayer)) {
        return;
      }
      const commands = extractDrawingCommandsFn(layer);
      if (!commands.length) {
        return;
      }

      ctx.save();

      const transforms = getTransformsForLayer(this.vectorLayer, layer.id);
      executeCommands(ctx, commands, transforms);

      // TODO: confirm this stroke multiplier thing works...
      const strokeWidthMultiplier = MathUtil.flattenTransforms(transforms).getScale();
      ctx.strokeStyle = ColorUtil.androidToCssColor(layer.strokeColor, layer.strokeAlpha);
      ctx.lineWidth = layer.strokeWidth * strokeWidthMultiplier;
      ctx.fillStyle = ColorUtil.androidToCssColor(layer.fillColor, layer.fillAlpha);
      ctx.lineCap = layer.strokeLinecap;
      ctx.lineJoin = layer.strokeLinejoin;
      ctx.miterLimit = layer.strokeMiterLimit;

      // TODO: update layer.pathData.length so that it reflects scale transforms
      if (layer.trimPathStart !== 0
        || layer.trimPathEnd !== 1
        || layer.trimPathOffset !== 0) {
        // Calculate the visible fraction of the trimmed path. If trimPathStart
        // is greater than trimPathEnd, then the result should be the combined
        // length of the two line segments: [trimPathStart,1] and [0,trimPathEnd].
        let shownFraction = layer.trimPathEnd - layer.trimPathStart;
        if (layer.trimPathStart > layer.trimPathEnd) {
          shownFraction += 1;
        }
        // Calculate the dash array. The first array element is the length of
        // the trimmed path and the second element is the gap, which is the
        // difference in length between the total path length and the visible
        // trimmed path length.
        ctx.setLineDash([
          shownFraction * layer.pathData.getPathLength(),
          (1 - shownFraction + 0.001) * layer.pathData.getPathLength()
        ]);
        // The amount to offset the path is equal to the trimPathStart plus
        // trimPathOffset. We mod the result because the trimmed path
        // should wrap around once it reaches 1.
        ctx.lineDashOffset = layer.pathData.getPathLength()
          * (1 - ((layer.trimPathStart + layer.trimPathOffset) % 1));
      } else {
        ctx.setLineDash([]);
      }
      if (layer.isStroked()
        && layer.strokeWidth
        && layer.trimPathStart !== layer.trimPathEnd) {
        ctx.stroke();
      }
      if (layer.isFilled()) {
        if (layer.fillType === 'evenOdd') {
          // Unlike VectorDrawables, SVGs spell 'evenodd' with a lowercase 'o'.
          ctx.fill('evenodd');
        } else {
          ctx.fill();
        }
      }
      ctx.restore();
    });
  }

  // Draw labeled points, highlights, selections, the pixel grid, etc.
  private drawOverlays() {
    if (!this.isViewInit) {
      return;
    }
    this.overlayCtx.save();
    this.setupCtxWithViewportCoords(this.overlayCtx);
    if (this.shouldDrawLayers) {
      // TODO: figure out what to do with selections
      // const selections =
      //   this.selectionService.getSelections()
      //     .filter(selection => selection.source === this.canvasType);
      // drawSelections(
      //   this.overlayCtx,
      //   this.vectorLayer,
      //   this.activePathId,
      //   selections,
      //   SELECTION_LINE_WIDTH / this.cssScale,
      // );
      this.drawHighlights(this.overlayCtx);
      this.drawLabeledPoints(this.overlayCtx);
      this.drawDraggingPoints(this.overlayCtx);
      this.drawAddPointPreview(this.overlayCtx);
    }
    this.overlayCtx.restore();

    // Note that the pixel grid is not drawn in viewport coordinates like above.
    if (this.cssScale > 4) {
      this.overlayCtx.save();
      this.overlayCtx.fillStyle = 'rgba(128, 128, 128, .25)';
      const devicePixelRatio = window.devicePixelRatio || 1;
      for (let x = 1; x < this.vlSize.width; x++) {
        this.overlayCtx.fillRect(
          x * this.attrScale - 0.5 * devicePixelRatio,
          0,
          devicePixelRatio,
          this.vlSize.height * this.attrScale);
      }
      for (let y = 1; y < this.vlSize.height; y++) {
        this.overlayCtx.fillRect(
          0,
          y * this.attrScale - 0.5 * devicePixelRatio,
          this.vlSize.width * this.attrScale,
          devicePixelRatio);
      }
      this.overlayCtx.restore();
    }
  }

  // Draw any highlighted subpaths.
  private drawHighlights(ctx: Context) {
    if (this.canvasType === CanvasType.Preview
      || !this.activePathId
      || !this.currentHover
      || this.currentHover.type !== HoverType.SubPath) {
      return;
    }

    const transforms = this.transformsForActiveLayer;
    const subPath = this.activePath.getSubPaths()[this.currentHover.index.subIdx];
    executeCommands(ctx, subPath.getCommands(), transforms);

    const lineWidth = SELECTION_LINE_WIDTH / this.cssScale;
    ctx.save();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = SELECTION_OUTER_COLOR;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.strokeStyle = SELECTION_INNER_COLOR;
    ctx.lineWidth = lineWidth / 2;
    ctx.stroke();
    ctx.restore();
  }

  // Draw any labeled points.
  private drawLabeledPoints(ctx: Context) {
    if (this.canvasType === CanvasType.Preview
      && !this.shouldLabelPoints
      || !this.activePathId) {
      return;
    }

    let path = this.activePath;
    if (this.currentHoverPreviewPath) {
      path = this.currentHoverPreviewPath;
    }

    interface PointInfo {
      cmd: Command;
      subIdx: number;
      cmdIdx: number;
    }

    const pathDataPointInfos: PointInfo[] =
      _.chain(path.getSubPaths() as SubPath[])
        .filter(subPath => !subPath.isCollapsing())
        .map((subPath, subIdx) => {
          return subPath.getCommands()
            .map((cmd, cmdIdx) => { return { cmd, subIdx, cmdIdx }; });
        })
        .flatMap(pointInfos => pointInfos)
        .value();

    const currSelections = this.selectionService.getSelections().map(sel => {
      return { subIdx: sel.index.subIdx, cmdIdx: sel.index.cmdIdx };
    });
    const selectedSubPathIndices = _.flatMap(currSelections, sel => {
      return sel.cmdIdx === undefined ? [sel.subIdx] : [];
    });

    const isPointInfoSelectedFn = (pointInfo: PointInfo) => {
      const { subIdx, cmdIdx } = pointInfo;
      const isSubPathSelected =
        selectedSubPathIndices.indexOf(subIdx) >= 0;
      if (isSubPathSelected) {
        return true;
      }
      return _.findIndex(currSelections, sel => {
        return sel.subIdx === subIdx && sel.cmdIdx === cmdIdx;
      }) >= 0;
    };

    pathDataPointInfos.push(
      ..._.remove(pathDataPointInfos, pointInfo => {
        return isPointInfoSelectedFn(pointInfo);
      }));

    const isPointInfoHoveringFn = (pointInfo: PointInfo) => {
      const hover = this.currentHover;
      if (!hover) {
        return false;
      }
      const type = hover.type;
      if (type === HoverType.SubPath) {
        return pointInfo.subIdx === hover.index.subIdx;
      }
      if (type === HoverType.Command) {
        return pointInfo.subIdx === hover.index.subIdx
          && pointInfo.cmdIdx === hover.index.cmdIdx;
      }
      return false;
    };

    pathDataPointInfos.push(
      ..._.remove(pathDataPointInfos, pointInfo => {
        return isPointInfoHoveringFn(pointInfo);
      }));

    const draggedCommandIndex =
      this.pointDragger
        && this.pointDragger.isDragging()
        && this.pointDragger.isMousePressedDown()
        && this.pointDragger.isSelectedPointSplit()
        ? this.pointDragger.getSelectedCommandIndex()
        : undefined;
    const transforms = this.transformsForActiveLayer.reverse();
    for (const pointInfo of pathDataPointInfos) {
      const { cmd, subIdx, cmdIdx } = pointInfo;
      if (draggedCommandIndex
        && subIdx === draggedCommandIndex.subIdx
        && cmdIdx === draggedCommandIndex.cmdIdx) {
        // Skip the currently dragged point. We'll draw that next.
        continue;
      }
      let radius = this.smallPointRadius;
      let text: string = undefined;
      if (isPointInfoHoveringFn(pointInfo) || isPointInfoSelectedFn(pointInfo)) {
        radius = this.largePointRadius * SELECTED_POINT_RADIUS_FACTOR;
        text = (cmdIdx + 1).toString();
      }
      if (pointInfo.cmd.isSplit()) {
        radius *= SPLIT_POINT_RADIUS_FACTOR;
      }
      const point = MathUtil.transformPoint(_.last(cmd.getPoints()), ...transforms);
      const color = cmd.isSplit() ? SPLIT_POINT_COLOR : NORMAL_POINT_COLOR;
      this.drawLabeledPoint(ctx, point, radius, color, text);
    }
  }

  // Draw any actively dragged points along the path (selection mode only).
  private drawDraggingPoints(ctx: Context) {
    if (this.appMode !== AppMode.SelectPoints
      || !this.lastKnownMouseLocation
      || !this.pointDragger
      || !this.pointDragger.isMousePressedDown()
      || !this.pointDragger.isDragging()
      || !this.pointDragger.isSelectedPointSplit()) {
      return;
    }
    // TODO: reuse this code
    const projectionOntoPath =
      calculateProjectionOntoPath(
        this.vectorLayer, this.activePathId, this.lastKnownMouseLocation);
    const projection = projectionOntoPath.projection;
    let point;
    if (projection.d < MIN_SNAP_THRESHOLD) {
      point = new Point(projection.x, projection.y);
      point = MathUtil.transformPoint(
        point, MathUtil.flattenTransforms(
          getTransformsForLayer(this.vectorLayer, this.activePathId).reverse()));
    } else {
      point = this.lastKnownMouseLocation;
    }
    this.drawLabeledPoint(
      ctx, point, this.largePointRadius * SPLIT_POINT_RADIUS_FACTOR, SPLIT_POINT_COLOR);
  }

  // Draw a preview of the newly added point (add points mode only).
  private drawAddPointPreview(ctx: Context) {
    if ((this.appMode !== AppMode.AddPoints
      && this.appMode !== AppMode.SplitSubPaths)
      || !this.lastKnownMouseLocation) {
      return;
    }
    // TODO: reuse this code
    // TODO: perform/save these calculations in a mouse event instead (to avoid extra overhead)?
    const projectionOntoPath =
      calculateProjectionOntoPath(
        this.vectorLayer, this.activePathId, this.lastKnownMouseLocation);
    const projection = projectionOntoPath.projection;
    let point;
    if (projection.d < MIN_SNAP_THRESHOLD) {
      point = new Point(projection.x, projection.y);
      point = MathUtil.transformPoint(
        point, MathUtil.flattenTransforms(
          getTransformsForLayer(this.vectorLayer, this.activePathId).reverse()));
      this.drawLabeledPoint(
        ctx, point, this.largePointRadius * SPLIT_POINT_RADIUS_FACTOR, SPLIT_POINT_COLOR);
    }
  }

  // Draws a labeled point with optional text.
  private drawLabeledPoint(
    ctx: Context,
    point: Point,
    radius: number,
    color: string,
    text?: string) {

    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius * POINT_BORDER_FACTOR, 0, 2 * Math.PI, false);
    ctx.fillStyle = POINT_BORDER_COLOR;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, 2 * Math.PI, false);
    ctx.fillStyle = color;
    ctx.fill();

    if (text) {
      ctx.beginPath();
      ctx.fillStyle = POINT_TEXT_COLOR;
      ctx.font = radius + 'px Roboto, Helvetica Neue, sans-serif';
      const width = ctx.measureText(text).width;
      // TODO: is there a better way to get the height?
      const height = ctx.measureText('o').width;
      ctx.fillText(text, point.x - width / 2, point.y + height / 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // MOUSE DOWN
  onMouseDown(event: MouseEvent) {
    this.showRuler(event);
    if (!this.shouldProcessMouseEvents) {
      return;
    }

    const mouseDown = this.mouseEventToPoint(event);
    this.lastKnownMouseLocation = mouseDown;

    let hitTestOpts: HitTestOpts;
    switch (this.appMode) {
      case AppMode.AddPoints:
      case AppMode.SplitSubPaths:
        hitTestOpts = { noPoints: true, noShapes: true };
        break;
    }
    const hitResult = this.performHitTest(mouseDown, hitTestOpts);

    if (this.appMode === AppMode.SelectPoints) {
      if (hitResult.isEndPointHit) {
        // A mouse down event ocurred on top of a point. Create a point selector
        // and track that sh!at.
        const hitPointIndex = _.last(hitResult.endPointHits);
        const selectedCmd =
          this.activePath
            .getSubPaths()[hitPointIndex.subIdx]
            .getCommands()[hitPointIndex.cmdIdx];
        this.pointDragger =
          new PointDragger(mouseDown, hitPointIndex, selectedCmd.isSplit());
      }
      // else if (!event.shiftKey && !event.metaKey) {
      //   // If the mouse down event didn't occur on top of a point, then
      //   // clear any existing selections, but only if the user isn't in
      //   // the middle of selecting multiple points at once.
      //   this.selectionService.reset();
      // }
      return;
    }

    if (this.appMode === AppMode.AddPoints || this.appMode === AppMode.SplitSubPaths) {
      if (hitResult.isSegmentHit) {
        const projection = _.last(hitResult.segmentHits).projection;
        this.shouldPerformActionOnMouseUp = projection.d < MIN_SNAP_THRESHOLD;
      }
      // TODO: track the previous hit result so we can avoid redrawing on every frame
      this.draw();
      return;
    }

    // TODO: hook this up with the UI
    // if (this.appMode === AppMode.PairSubPaths) {
    //   const selectedSubIdx =
    //     performSubPathHitTest(this.vectorLayer, this.activePathId, mouseDown);
    //   if (selectedSubIdx !== undefined) {
    //     const selections = this.selectionService.getSelections();
    //     const oppositeCanvasType =
    //       this.canvasType === CanvasType.Start ? CanvasType.End : CanvasType.Start;
    //     this.selectionService.reset();
    //     if (selections.length && selections[0].source !== this.canvasType) {
    //       // TODO: this UX should be improved before release...
    //       // TODO: keep the subpaths selected until all have been paired?
    //       // Then a subpath is currently selected in the canvas, so pair
    //       // the two selected subpaths together.
    //       const activePath = this.activePath;
    //       const oppositeActivePath =
    //         this.stateService.getActivePathLayer(oppositeCanvasType).pathData;
    //       const currSelectedSubIdx = selectedSubIdx;
    //       const oppositeSelectedSubIdx = selections[0].index.subIdx;
    //       this.stateService.updateActivePath(
    //         this.canvasType,
    //         activePath.mutate().moveSubPath(currSelectedSubIdx, 0).build(),
    //         false);
    //       this.stateService.updateActivePath(
    //         oppositeCanvasType,
    //         oppositeActivePath.mutate().moveSubPath(oppositeSelectedSubIdx, 0).build(),
    //         false);
    //       this.stateService.notifyChange(CanvasType.Preview);
    //       this.stateService.notifyChange(CanvasType.Start);
    //       this.stateService.notifyChange(CanvasType.End);
    //     } else if (!selections.length || selections[0].source === oppositeCanvasType) {
    //       const subPath = this.activePath.getSubPaths()[selectedSubIdx];
    //       for (let cmdIdx = 0; cmdIdx < subPath.getCommands().length; cmdIdx++) {
    //         this.selectionService.toggle({
    //           type: SelectionType.Command,
    //           index: { subIdx: selectedSubIdx, cmdIdx },
    //           source: this.canvasType
    //         }, true);
    //       }
    //     }
    //   }
    // }
  }

  // MOUSE MOVE
  onMouseMove(event: MouseEvent) {
    this.showRuler(event);
    if (!this.shouldProcessMouseEvents) {
      return;
    }

    const mouseMove = this.mouseEventToPoint(event);
    this.lastKnownMouseLocation = mouseMove;

    if (this.appMode === AppMode.SelectPoints) {
      let isDraggingSplitPoint = false;
      if (this.pointDragger) {
        this.pointDragger.onMouseMove(mouseMove);
        isDraggingSplitPoint =
          this.pointDragger.isSelectedPointSplit() && this.pointDragger.isDragging();
        if (isDraggingSplitPoint) {
          this.draw();
          // TODO: while dragging, draw the highlighted segment when snapping to a new loation
          return;
        }
      }
    }

    const hitResult = this.performHitTest(mouseMove);
    this.processHitResult(hitResult);
    // TODO: track the previous hit result so we can avoid redrawing on every frame
    this.draw();
  }

  // MOUSE UP
  onMouseUp(event: MouseEvent) {
    this.showRuler(event);
    if (!this.shouldProcessMouseEvents) {
      return;
    }

    const mouseUp = this.mouseEventToPoint(event);
    this.lastKnownMouseLocation = mouseUp;

    if (this.appMode === AppMode.SelectPoints) {
      if (this.pointDragger) {
        this.pointDragger.onMouseUp(mouseUp);

        const selectedCommandIndex = this.pointDragger.getSelectedCommandIndex();
        if (this.pointDragger.isDragging()) {
          if (this.pointDragger.isSelectedPointSplit()) {
            const projOntoPath =
              calculateProjectionOntoPath(this.vectorLayer, this.activePathId, mouseUp);
            const { subIdx: newSubIdx, cmdIdx: newCmdIdx } = projOntoPath;
            const { subIdx: oldSubIdx, cmdIdx: oldCmdIdx } = this.pointDragger.getSelectedCommandIndex();
            if (newSubIdx === oldSubIdx) {
              const activeLayer = this.stateService.getActivePathLayer(this.canvasType);
              const startingPath = activeLayer.pathData;
              let pathMutator = startingPath.mutate();

              // Note that the order is important here, as it preserves the command indices.
              if (newCmdIdx > oldCmdIdx) {
                pathMutator.splitCommand(newSubIdx, newCmdIdx, projOntoPath.projection.t);
                pathMutator.unsplitCommand(oldSubIdx, oldCmdIdx);
              } else if (newCmdIdx < oldCmdIdx) {
                pathMutator.unsplitCommand(oldSubIdx, oldCmdIdx);
                pathMutator.splitCommand(newSubIdx, newCmdIdx, projOntoPath.projection.t);
              } else {
                // Unsplitting will cause the projection t value to change, so recalculate the
                // projection before the split.
                // TODO: improve this API somehow... having to set the active layer here is kind of hacky
                activeLayer.pathData = pathMutator.unsplitCommand(oldSubIdx, oldCmdIdx).build();
                const tempProjOntoPath =
                  calculateProjectionOntoPath(this.vectorLayer, this.activePathId, mouseUp);
                if (oldSubIdx === tempProjOntoPath.subIdx) {
                  pathMutator.splitCommand(
                    tempProjOntoPath.subIdx, tempProjOntoPath.cmdIdx, tempProjOntoPath.projection.t);
                } else {
                  // If for some reason the projection subIdx changes after the unsplit, we have no
                  // choice but to give up.
                  // TODO: Make this user experience better. There could be other subIdxs that we could use.
                  pathMutator = startingPath.mutate();
                }
              }

              // Notify the global layer state service about the change and draw.
              // Clear any existing selections and/or hovers as well.
              this.hoverService.reset();
              this.selectionService.reset();
              this.stateService.updateActivePath(this.canvasType, pathMutator.build());
            }
          }
        } else {
          // If we haven't started dragging a point, then we should select
          // the subpath and point instead.
          this.selectionService.toggle({
            type: SelectionType.SubPath,
            source: this.canvasType,
            index: { subIdx: selectedCommandIndex.subIdx },
          });
          this.selectionService.toggle({
            type: SelectionType.Command,
            source: this.canvasType,
            index: selectedCommandIndex,
          }, event.shiftKey || event.metaKey);
        }

        // Draw and complete the gesture.
        this.draw();
        this.pointDragger = undefined;
      }
      return;
    }

    let hitTestOpts: HitTestOpts;
    const hitResult = this.performHitTest(mouseUp, hitTestOpts);

    if (this.appMode === AppMode.AddPoints || this.appMode === AppMode.SplitSubPaths) {
      if (this.shouldPerformActionOnMouseUp) {
        const projOntoPath =
          calculateProjectionOntoPath(
            this.vectorLayer, this.activePathId, this.lastKnownMouseLocation);
        const { subIdx, cmdIdx, projection } = projOntoPath;
        if (projection.d < MIN_SNAP_THRESHOLD) {
          // We're in range, so split the path!
          const activePathLayer = this.stateService.getActivePathLayer(this.canvasType);
          const pathMutator = activePathLayer.pathData.mutate();
          if (this.appMode === AppMode.AddPoints) {
            pathMutator.splitCommand(subIdx, cmdIdx, projection.t);
          } else if (this.appMode === AppMode.SplitSubPaths) {
            if (activePathLayer.isFilled()) {
              if (!this.initialFilledSubPathProjOntoPath) {
                this.initialFilledSubPathProjOntoPath = projOntoPath;
              } else if (this.initialFilledSubPathProjOntoPath.subIdx !== projOntoPath.subIdx) {
                // TODO: don't allow other subIdx values to be returned by the above projection...
                this.initialFilledSubPathProjOntoPath = undefined;
              } else {
                let firstCmdIdx = this.initialFilledSubPathProjOntoPath.cmdIdx;
                let firstT = this.initialFilledSubPathProjOntoPath.projection.t;
                let secondCmdIdx = projOntoPath.cmdIdx;
                let secondT = projOntoPath.projection.t;
                if (firstCmdIdx > secondCmdIdx
                  || firstCmdIdx === secondCmdIdx && firstT > secondT) {
                  const temp = { firstCmdIdx, firstT };
                  firstCmdIdx = secondCmdIdx;
                  firstT = secondT;
                  secondCmdIdx = temp.firstCmdIdx;
                  secondT = temp.firstT;
                }
                pathMutator
                  .splitCommand(projOntoPath.subIdx, firstCmdIdx, firstT)
                  .splitCommand(projOntoPath.subIdx, secondCmdIdx + 1, secondT)
                  .splitFilledSubPath(projOntoPath.subIdx, firstCmdIdx, secondCmdIdx + 1);
                this.initialFilledSubPathProjOntoPath = undefined;
              }
            } else if (activePathLayer.isStroked()) {
              pathMutator
                .splitCommand(subIdx, cmdIdx, projection.t)
                .splitStrokedSubPath(subIdx, cmdIdx);
            }
          }
          this.stateService.updateActivePath(this.canvasType, pathMutator.build());
        } else {
          this.initialFilledSubPathProjOntoPath = undefined;
        }
        this.shouldPerformActionOnMouseUp = false;
      }
      // TODO: avoid redrawing on every frame... often times it will be unnecessary
      this.draw();
    }
  }

  onMouseLeave(event: MouseEvent) {
    this.canvasRulers.forEach(r => r.hideMouse());
    if (!this.shouldProcessMouseEvents) {
      return;
    }

    const mouseLeave = this.mouseEventToPoint(event);
    this.lastKnownMouseLocation = mouseLeave;

    if (this.appMode === AppMode.SelectPoints) {
      // TODO: how to handle the case where the mouse leaves and re-enters mid-gesture?
      if (this.pointDragger) {
        this.pointDragger.onMouseLeave(mouseLeave);
        this.draw();
      }
    } else if (this.appMode === AppMode.AddPoints
      || this.appMode === AppMode.SplitSubPaths) {
      // If the user clicks to perform an action but the mouse leaves the
      // canvas before mouse up is registered, then just cancel the event.
      // This way we can avoid some otherwise confusing behavior.
      this.shouldPerformActionOnMouseUp = false;
      this.initialFilledSubPathProjOntoPath = undefined;
      // TODO: avoid redrawing on every frame... often times it will be unnecessary
      this.draw();
    }
  }

  private performHitTest(mousePoint: Point, opts: HitTestOpts = {}) {
    const transformMatrix =
      Matrix.flatten(...this.transformsForActiveLayer.reverse()).invert();
    const transformedMousePoint = MathUtil.transformPoint(mousePoint, transformMatrix);
    let isPointInRangeFn: (distance: number, cmd: Command) => boolean;
    if (!opts.noPoints) {
      isPointInRangeFn = (distance, cmd) => {
        const multiplyFactor = cmd.isSplit() ? SPLIT_POINT_RADIUS_FACTOR : 1;
        return distance <= this.largePointRadius * multiplyFactor;
      };
    }
    let isSegmentInRangeFn: (distance: number, cmd: Command) => boolean;
    if (!opts.noSegments) {
      isSegmentInRangeFn = distance => {
        return distance <= this.activePathLayer.strokeWidth / 2;
      };
    }
    const findShapesInRange = this.activePathLayer.isFilled() && !opts.noShapes;
    return this.activePath.hitTest(transformedMousePoint, {
      isPointInRangeFn,
      isSegmentInRangeFn,
      findShapesInRange,
    });
  }

  private processHitResult(hitResult: HitResult) {
    if (hitResult.isHit) {
      if (hitResult.endPointHits.length) {
        const endPointInfos = hitResult.endPointHits.map(index => {
          const { subIdx, cmdIdx } = index;
          const cmd = this.activePath.getSubPaths()[subIdx].getCommands()[cmdIdx];
          return { index, cmd };
        });
        const lastSplitIndex =
          _.findLastIndex(endPointInfos, cmdInfo => cmdInfo.cmd.isSplit());
        const hoverIndex =
          endPointInfos[lastSplitIndex < 0 ? endPointInfos.length - 1 : lastSplitIndex].index;
        this.hoverService.setHover({
          type: HoverType.Command,
          source: this.canvasType,
          index: hoverIndex,
        });
      } else if (hitResult.shapeHits.length) {
        const subPathInfos = hitResult.shapeHits.map(index => {
          const { subIdx } = index;
          const subPath = this.activePath.getSubPaths()[subIdx];
          return { index, subPath };
        });
        const lastSplitIndex =
          _.findLastIndex(subPathInfos, subPathInfo => subPathInfo.subPath.isSplit());
        const hoverIndex =
          subPathInfos[lastSplitIndex < 0 ? subPathInfos.length - 1 : lastSplitIndex].index;
        this.hoverService.setHover({
          type: HoverType.SubPath,
          source: this.canvasType,
          index: hoverIndex,
        });
      }
    } else {
      this.hoverService.reset();
    }
  }
}

/**
 * Returns a list of parent transforms for the specified layer ID. The transforms
 * are returned in top-down order (i.e. the transform for the layer's
 * immediate parent will be the very last matrix in the returned list). This
 * function returns undefined if the layer is not found in the vector layer.
 */
function getTransformsForLayer(vectorLayer: VectorLayer, layerId: string) {
  const getTransformsFn = (parents: Layer[], current: Layer): Matrix[] => {
    if (current.id === layerId) {
      return _.flatMap(parents, layer => {
        if (!(layer instanceof GroupLayer)) {
          return [];
        }
        return [
          Matrix.fromTranslation(layer.pivotX, layer.pivotY),
          Matrix.fromTranslation(layer.translateX, layer.translateY),
          Matrix.fromRotation(layer.rotation),
          Matrix.fromScaling(layer.scaleX, layer.scaleY),
          Matrix.fromTranslation(-layer.pivotX, -layer.pivotY),
        ];
      });
    }
    if (current.children) {
      for (const child of current.children) {
        const transforms = getTransformsFn(parents.concat([current]), child);
        if (transforms) {
          return transforms;
        }
      }
    }
    return undefined;
  };
  return getTransformsFn([], vectorLayer);
}

function performSubPathHitTest(
  vectorLayer: VectorLayer,
  pathId: string,
  mousePoint: Point): number | undefined {

  const pathLayer = vectorLayer.findLayer(pathId) as PathLayer;
  if (!pathLayer) {
    return undefined;
  }
  const transforms = getTransformsForLayer(vectorLayer, pathId).reverse();
  const transformedMousePoint =
    MathUtil.transformPoint(
      mousePoint,
      MathUtil.flattenTransforms(transforms).invert());
  let isSegmentInRangeFn: (distance: number, cmd?: Command) => boolean;
  if (pathLayer.isStroked()) {
    isSegmentInRangeFn = (distance: number) => {
      return distance <= pathLayer.strokeWidth / 2;
    };
  }
  const findShapesInRange = pathLayer.isFilled();
  const hitResult =
    pathLayer.pathData.hitTest(
      transformedMousePoint, { isSegmentInRangeFn, findShapesInRange });
  if (!hitResult.isHit) {
    return undefined;
  }
  if (hitResult.segmentHits.length) {
    return _.last(hitResult.segmentHits).subIdx;
  }
  return _.last(hitResult.shapeHits).subIdx;
}

// Note that this function currently only supports contiguous sequences of commands.
function executeCommands(
  ctx: Context,
  commands: ReadonlyArray<Command>,
  transforms: Matrix[]) {

  ctx.save();
  transforms.forEach(m => ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f));
  ctx.beginPath();

  let previousEndPoint: Point;
  commands.forEach(cmd => {
    const start = cmd.getStart();
    const end = cmd.getEnd();

    if (cmd.getSvgChar() === 'M') {
      ctx.moveTo(end.x, end.y);
    } else if (cmd.getSvgChar() === 'L') {
      ctx.lineTo(end.x, end.y);
    } else if (cmd.getSvgChar() === 'Q') {
      ctx.quadraticCurveTo(
        cmd.getPoints()[1].x, cmd.getPoints()[1].y,
        cmd.getPoints()[2].x, cmd.getPoints()[2].y);
    } else if (cmd.getSvgChar() === 'C') {
      ctx.bezierCurveTo(
        cmd.getPoints()[1].x, cmd.getPoints()[1].y,
        cmd.getPoints()[2].x, cmd.getPoints()[2].y,
        cmd.getPoints()[3].x, cmd.getPoints()[3].y);
    } else if (cmd.getSvgChar() === 'Z') {
      if (start.equals(previousEndPoint)) {
        ctx.closePath();
      } else {
        // This is mainly to support the case where the list of commands
        // is size one and contains only a closepath command.
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
      }
    }
    previousEndPoint = end;
  });
  ctx.restore();
}

/**
 * Calculates the projection onto the path with the specified path ID.
 * The resulting projection is our way of determining the on-curve point
 * closest to the specified off-curve mouse point.
 */
function calculateProjectionOntoPath(
  vectorLayer: VectorLayer,
  pathId: string,
  mousePoint: Point,
  overridePath?: Path): ProjectionOntoPath | undefined {

  const pathLayer = vectorLayer.findLayer(pathId) as PathLayer;
  if (!pathLayer) {
    return undefined;
  }
  const transforms = getTransformsForLayer(vectorLayer, pathId).reverse();
  const transformedMousePoint =
    MathUtil.transformPoint(
      mousePoint,
      MathUtil.flattenTransforms(transforms).invert());
  const projInfo = pathLayer.pathData.project(transformedMousePoint);
  if (!projInfo) {
    return undefined;
  }
  return {
    subIdx: projInfo.subIdx,
    cmdIdx: projInfo.cmdIdx,
    projection: projInfo.projection,
  };
}

/**
 * Helper class that tracks information about a user's mouse gesture.
 */
class PointDragger {
  private isDragTriggered = false;
  private isMouseDown = true;

  constructor(
    private readonly mouseDown: Point,
    private readonly selectedCommandIndex: { subIdx: number, cmdIdx: number },
    private readonly selectedPointSplit: boolean,
  ) { }

  onMouseMove(mouseMove: Point) {
    const distance = MathUtil.distance(this.mouseDown, mouseMove);
    if (DRAG_TRIGGER_TOUCH_SLOP < distance) {
      this.isDragTriggered = true;
    }
  }

  onMouseUp(mouseUp: Point) {
    this.isMouseDown = false;
  }

  onMouseLeave(mouseLeave: Point) { }

  isDragging() {
    return this.isDragTriggered;
  }

  isMousePressedDown() {
    return this.isMouseDown;
  }

  getSelectedCommandIndex() {
    return this.selectedCommandIndex;
  }

  isSelectedPointSplit() {
    return this.selectedPointSplit;
  }
}

interface HitTestOpts {
  noPoints?: boolean;
  noSegments?: boolean;
  noShapes?: boolean;
}
