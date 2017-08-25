import { MathUtil } from 'app/scripts/common';
import * as $ from 'jquery';
import * as paper from 'paper';

import { AbstractTool } from './AbstractTool';
import {
  Gesture,
  RotateGesture,
  ScaleGesture,
  SelectionBoxGesture,
  SelectionGesture,
} from './gesture';
import { Guides, Items, Selections } from './util';

enum Mode {
  None,
  Scale,
  Rotate,
  MoveShapes,
  CloneShapes,
  SelectionBox,
}

/**
 * A simple selection tool for moving, scaling, rotating, and selecting shapes.
 * TODO: figure out how to deal with right mouse clicks and double clicks
 */
export class SelectionTool extends AbstractTool {
  private currentGesture: Gesture;

  // @Override
  protected onActivate() {}

  // @Override
  protected onMouseDown(event: paper.ToolEvent) {
    Guides.hideHoverPath();

    const hitResult = paper.project.hitTest(event.point, this.createHitOptions());
    if (hitResult) {
      const hitItem = hitResult.item;
      if (Guides.isScaleHandle(hitItem)) {
        this.currentGesture = new ScaleGesture();
      } else if (Guides.isRotationHandle(hitItem)) {
        this.currentGesture = new RotateGesture();
      } else if (event.modifiers.shift && hitItem.selected) {
        // Simply de-select the event and we are done.
        this.currentGesture = new class extends Gesture {
          // @Override
          onMouseDown(e: paper.ToolEvent, { item }: paper.HitResult) {
            Selections.setSelection(item, false);
          }
        }();
      } else {
        const shouldCloneShape = event.modifiers.alt;
        this.currentGesture = new SelectionGesture(shouldCloneShape);
      }
    } else {
      this.currentGesture = new SelectionBoxGesture();
    }

    this.currentGesture.onMouseDown(event, hitResult);
  }

  // @Override
  protected onMouseDrag(event: paper.ToolEvent) {
    this.currentGesture.onMouseDrag(event);
  }

  // @Override
  protected onMouseMove(event: paper.ToolEvent) {
    maybeShowHoverPath(event.point, this.createHitOptions());
  }

  // @Override
  protected onMouseUp(event: paper.ToolEvent) {
    this.currentGesture.onMouseUp(event);

    if (Selections.getSelectedItems().length) {
      maybeShowSelectionBounds();
    } else {
      Guides.hideSelectionBounds();
    }
  }

  // @Override
  protected onSingleClickConfirmed(event: paper.ToolEvent) {}

  // @Override
  protected onDoubleClick(event: paper.ToolEvent) {}

  // @Override
  protected onDeactivate() {}

  private createHitOptions(): paper.HitOptions {
    return {
      segments: true,
      stroke: true,
      curves: true,
      fill: true,
      tolerance: 8 / paper.view.zoom,
    };
  }
}

// TODO: make use of this function!
// var preProcessSelection = function() {
//   // when switching to the select tool while having a child object of a
//   // compound path selected, deselect the child and select the compound path
//   // instead. (otherwise the compound path breaks because of scale-grouping)
//   var items = pg.selection.getSelectedItems();
//   jQuery.each(items, function(index, item) {
//     if(pg.compoundPath.isCompoundPathChild(item)) {
//       var cp = pg.compoundPath.getItemsCompoundPath(item);
//       pg.selection.setItemSelection(item, false);
//       pg.selection.setItemSelection(cp, true);
//     }
//   });
//   setSelectionBounds();
// };

function maybeShowHoverPath(point: paper.Point, hitOptions: paper.HitOptions) {
  // TODO: can this removal/addition be made more efficient?
  Guides.hideHoverPath();
  const hitResult = paper.project.hitTest(point, hitOptions);
  if (!hitResult) {
    return;
  }
  // TODO: support hover events for groups and layers?
  const { item } = hitResult;
  if (!item.selected && Items.isPath(item)) {
    Guides.showHoverPath(item);
  }
}

/**
 * Shows a selection group around all currently selected items, or hides the
 * selection group if no selected items exist.
 */
function maybeShowSelectionBounds() {
  // TODO: can this removal/addition be made more efficient?
  Guides.hideSelectionBounds();
  // TODO: support group selections, compound path selections, etc.
  const items = Selections.getSelectedItems();
  if (items.length === 0) {
    return;
  }
  console.log('showSelectionBounds', Items.computeBoundingBox(items));
  Guides.showSelectionBounds(Items.computeBoundingBox(items));
}