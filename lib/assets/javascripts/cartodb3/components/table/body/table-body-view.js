var CoreView = require('backbone/core-view');
var $ = require('jquery');
var _ = require('underscore');
var Clipboard = require('clipboard');
var browserDetect = require('../../../helpers/browser-detect');
var TableBodyRowView = require('./table-body-row-view');
var ContextMenuView = require('../../context-menu/context-menu-view');
var CustomListCollection = require('../../custom-list/custom-list-collection');
var addTableRowOperation = require('../operations/table-add-row');
var removeTableRowOperation = require('../operations/table-remove-row');
var editCellOperation = require('../operations/table-edit-cell');
var ConfirmationModalView = require('../../modals/confirmation/modal-confirmation-view');
var TablePaginatorView = require('../paginator/table-paginator-view');
var tableBodyTemplate = require('./table-body.tpl');
var renderLoading = require('../../loading/render-loading');
var ErrorView = require('../../error/error-view');
var tableNoRowsTemplate = require('./table-no-rows.tpl');
var EditorsServiceModel = require('../editors/editors-service-model');
var EditorsModel = require('../editors/types/editor-model');

var EDITORS_MAP = {
  'string': require('../editors/types/editor-string-view'),
  'number': require('../editors/types/editor-base-view'),
  'boolean': require('../editors/types/editor-boolean-view'),
  'date': require('../editors/types/editor-date-view'),
  'default': require('../editors/types/editor-string-view')
};

/*
 *  Table body view
 */

module.exports = CoreView.extend({

  className: 'Table-body',
  tagName: 'div',

  events: {
    'click .js-options': '_showContextMenu',
    'dblclick .js-value': '_onDblClickValue'
  },

  initialize: function (opts) {
    if (!opts.querySchemaModel) throw new Error('querySchemaModel is required');
    if (!opts.rowsCollection) throw new Error('rowsCollection is required');
    if (!opts.columnsCollection) throw new Error('columnsCollection is required');
    if (!opts.tableViewModel) throw new Error('tableViewModel');
    if (!opts.modals) throw new Error('modals is required');

    this._modals = opts.modals;
    this._tableViewModel = opts.tableViewModel;
    this._querySchemaModel = opts.querySchemaModel;
    this._columnsCollection = opts.columnsCollection;
    this._rowsCollection = opts.rowsCollection;
    this._editors = new EditorsServiceModel();

    this._closeEditor = this._closeEditor.bind(this);
    this._hideContextMenu = this._hideContextMenu.bind(this);

    this._initBinds();
  },

  render: function () {
    this.clearSubViews();
    this._destroyScrollBinding();
    this.$el.empty();

    if (this._querySchemaModel.get('status') !== 'fetched') {
      this._renderQueryState();
    } else {
      if (!this._rowsCollection.size()) {
        this._renderNoRows();
      } else {
        this.$el.html(tableBodyTemplate());
        this._rowsCollection.each(this._renderBodyRow, this);
        this._initPaginator();
      }
    }

    this.$el.toggleClass('Table-body--relative', !!this._tableViewModel.get('relativePositionated'));

    return this;
  },

  _initBinds: function () {
    this._querySchemaModel.bind('change:status', function (mdl, status) {
      if (status !== 'fetched' && status !== 'unfetched') {
        this.render();
      }
    }, this);
    this._rowsCollection.bind('reset', _.debounce(this.render.bind(this), 20), this);
    this._rowsCollection.bind('add', function (model) {
      if (this._rowsCollection.size() === 1) {
        this.render();
      } else {
        this._renderBodyRow(model);
        this._scrollToBottom();
      }
    }, this);
    this._rowsCollection.bind('remove', this._onRemoveRow, this);
    this.add_related_model(this._querySchemaModel);
    this.add_related_model(this._rowsCollection);
  },

  _renderQueryState: function () {
    var status = this._querySchemaModel.get('status');
    var content = renderLoading({
      title: _t('components.table.rows.loading.title')
    });

    if (status === 'unavailable') {
      var view = new ErrorView({
        title: _t('components.table.rows.error.title'),
        desc: _t('components.table.rows.error.desc')
      });
      this.addView(view);
      content = view.render().el;
    }

    this.$el.html(content);
  },

  _renderNoRows: function () {
    this.$el.html(
      tableNoRowsTemplate({
        page: this._tableViewModel.get('page'),
        customQuery: this._tableViewModel.isCustomQueryApplied()
      })
    );
  },

  _initPaginator: function () {
    var paginatorView = new TablePaginatorView({
      rowsCollection: this._rowsCollection,
      tableViewModel: this._tableViewModel
    });

    // Bug in Chrome with position:fixed :(, so we have to choose body as
    // parent
    var $el = $('body');
    // But if we have chosen relativePositionated, we should add close
    // to the table view
    if (this._tableViewModel.get('relativePositionated')) {
      $el = this.$el.closest('.Table').parent();
    }

    $el.append(paginatorView.render().el);
    this.addView(paginatorView);
  },

  _initScrollBinding: function () {
    $('.Table').scroll(this._hideContextMenu);
    this.$('.js-tbody').scroll(this._hideContextMenu);
  },

  _destroyScrollBinding: function () {
    $('.Table').off('scroll', this._hideContextMenu);
    this.$('.js-tbody').off('scroll', this._hideContextMenu);
  },

  _renderBodyRow: function (mdl) {
    var view = new TableBodyRowView({
      model: mdl,
      columnsCollection: this._columnsCollection,
      querySchemaModel: this._querySchemaModel,
      tableViewModel: this._tableViewModel
    });
    this.addView(view);
    this.$('.js-tbody').append(view.render().el);
  },

  _onRemoveRow: function () {
    if (!this._rowsCollection.size()) {
      var page = this._tableViewModel.get('page');
      if (page > 0) {
        this._tableViewModel.set('page', page - 1);
      } else {
        this.render();
      }
    }
  },

  _hasContextMenu: function () {
    return this._menuView;
  },

  _hideContextMenu: function () {
    this._unhighlightCell();
    this._destroyScrollBinding();
    this._menuView.collection.unbind(null, null, this);
    this._menuView.remove();
    this.removeView(this._menuView);
    delete this._menuView;
  },

  _highlightCell: function ($tableCellItem, $tableRow) {
    $tableCellItem.addClass('is-highlighted');
    $tableRow.addClass('is-highlighted');
  },

  _unhighlightCell: function () {
    this.$('.Table-cellItem.is-highlighted, .Table-row.is-highlighted').removeClass('is-highlighted');
  },

  _showContextMenu: function (ev) {
    var self = this;
    var position = { x: ev.clientX, y: ev.clientY };
    var $tableRow = $(ev.target).closest('.Table-row');
    var $tableCellItem = $(ev.target).closest('.Table-cellItem');
    var modelCID = $tableRow.data('model');
    var attribute = $tableCellItem.data('attribute');
    var rowModel = self._rowsCollection.get({ cid: modelCID });
    var browser = browserDetect();
    var menuItems = [];

    if (browser.name !== 'Safari') {
      menuItems.push({
        label: _t('components.table.rows.options.copy'),
        val: 'copy',
        action: function () {
          self._copyValue($tableCellItem);
        }
      });
    }

    if (!this._tableViewModel.isDisabled()) {
      menuItems = [
        {
          label: _t('components.table.rows.options.edit'),
          val: 'edit',
          action: function () {
            self._editCell(rowModel, attribute);
          }
        }, {
          label: _t('components.table.rows.options.create'),
          val: 'create',
          action: function () {
            self._addRow();
          }
        }
      ].concat(menuItems);

      menuItems.push({
        label: _t('components.table.rows.options.delete'),
        val: 'delete',
        destructive: true,
        action: function () {
          self._removeRow(rowModel);
        }
      });
    }

    // No options?, don't open anything
    if (!menuItems.length) {
      return false;
    }

    var collection = new CustomListCollection(menuItems);

    this._menuView = new ContextMenuView({
      className: 'Table-rowMenu ' + ContextMenuView.prototype.className,
      collection: collection,
      triggerElementID: modelCID,
      position: position
    });

    // Show options up
    if ($tableRow.index() > 36) {
      this._menuView.$el.css({
        'margin-top': -((collection.size() * 40) + 35) + 'px'
      });
    }

    collection.bind('change:selected', function (menuItem) {
      var action = menuItem.get('action');
      action && action();
    }, this);

    this._menuView.model.bind('change:visible', function (model, isContextMenuVisible) {
      if (this._hasContextMenu() && !isContextMenuVisible) {
        this._hideContextMenu();
      }
    }, this);

    this._menuView.show();
    this.addView(this._menuView);

    this._highlightCell($tableCellItem, $tableRow);
    this._initScrollBinding();
  },

  _onDblClickValue: function (ev) {
    var $tableCellItem = $(ev.target).closest('.Table-cellItem');
    var $tableRow = $tableCellItem.closest('.Table-row');
    var modelCID = $tableRow.data('model');
    var attribute = $tableCellItem.data('attribute');
    var rowModel = this._rowsCollection.get({ cid: modelCID });

    if (!this._tableViewModel.isDisabled() && rowModel && attribute && attribute !== 'cartodb_id') {
      this._editCell(rowModel, attribute);
    }
  },

  _copyValue: function ($el) {
    // Work-around for Clipboard \o/
    this._clipboard = new Clipboard($el.get(0));
    $el.click();
    this._clipboard.destroy();
  },

  _addRow: function () {
    addTableRowOperation({
      rowsCollection: this._rowsCollection
    });
  },

  _initEditorScrollBinding: function () {
    $('.Table').scroll(this._closeEditor);
    this.$('.js-tbody').scroll(this._closeEditor);
  },

  _destroyEditorScrollBinding: function () {
    $('.Table').unbind('scroll', this._closeEditor);
    this.$('.js-tbody').unbind('scroll', this._closeEditor);
  },

  _closeEditor: function () {
    this._unhighlightCell();
    this._destroyEditorScrollBinding();
    this._editors.unbind(null, null, this);
    this._editors.destroy();
  },

  _saveValue: function (rowModel, attribute, newValue) {
    if (rowModel.get(attribute) !== newValue) {
      editCellOperation({
        rowModel: rowModel,
        attribute: attribute,
        newValue: newValue
      });
    }
  },

  _editCell: function (rowModel, attribute) {
    var $tableRow = this.$('[data-model="' + rowModel.cid + '"]');
    var $tableCell = $tableRow.find('[data-attribute="' + attribute + '"]');
    var $options = $tableCell.find('.js-options');
    var columnModel = _.first(this._columnsCollection.where({ name: attribute }));
    var type = columnModel.get('type');

    this._highlightCell($tableCell, $tableRow);
    this._initEditorScrollBinding();

    var model = new EditorsModel({
      type: type,
      value: rowModel.get(attribute)
    });

    this._editors.bind('destroyedEditor', this._closeEditor, this);
    this._editors.bind('confirmedEditor', function () {
      if (model.isValid()) {
        this._saveValue(
          rowModel,
          attribute,
          model.get('value')
        );
      }
    }, this);

    var position = $options.offset();

    if ($tableCell.index() > 1) {
      position.right = window.innerWidth - position.left;
      delete position.left;
    }

    if (this._rowsCollection.size() > 4 && ($tableRow.index() + 2) >= (this._rowsCollection.size() - 1)) {
      position.bottom = window.innerHeight - position.top;
      delete position.top;
    } else {
      position.top = position.top + 20;
    }

    var View = EDITORS_MAP[type];

    if (!View) {
      View = EDITORS_MAP['default'];
    }

    this._editors.create(
      function (editorModel) {
        return new View({
          editorModel: editorModel,
          model: model
        });
      },
      position
    );
  },

  _removeRow: function (rowModel) {
    var self = this;

    this._modals.create(
      function (modalModel) {
        return new ConfirmationModalView({
          modalModel: modalModel,
          template: require('./modals-templates/remove-table-row.tpl'),
          renderOpts: {
            cartodb_id: rowModel.get('cartodb_id')
          },
          loadingTitle: _t('components.table.rows.destroy.loading', {
            cartodb_id: rowModel.get('cartodb_id')
          }),
          runAction: function () {
            removeTableRowOperation({
              tableViewModel: self._tableViewModel,
              rowModel: rowModel,
              onSuccess: function () {
                modalModel.destroy();
              },
              onError: function (e) {
                modalModel.destroy();
              }
            });
          }
        });
      }
    );
  },

  _scrollToBottom: function () {
    var tbodyHeight = this.$('.js-tbody').get(0).scrollHeight;
    this.$('.js-tbody').animate({
      scrollTop: tbodyHeight
    }, 'slow');
  },

  clean: function () {
    this._destroyScrollBinding();
    CoreView.prototype.clean.apply(this);
  }

});
