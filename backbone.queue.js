import Backbone from 'backbone-models-react-native';
import _ from 'underscore';
import Store from 'react-native-simple-store';
import async from 'async';
import uuid from 'uuid';

Backbone.Model.prototype.cidAttribute = '_cid';

Backbone.Collection.prototype.pendingChangesStorageKey = 
Backbone.Model.prototype.pendingChangesStorageKey = function(action) {
    if (!action) throw new Error('expected action type for pendingChangesStorageKey');
    var prefix = Backbone.QUEUE_STORAGE_PREFIX ||
                 "backbone-queue-storage-";
    return prefix + _.result(this, 'url')+'['+action+']';
};

Backbone.Model.prototype.pendingNewModelStorageKey = function() {
    var prefix = Backbone.QUEUE_STORAGE_PREFIX ||
                 "backbone-queue-storage-";
    return prefix + _.result(this, 'urlRoot') + '/' + this.get(this.cidAttribute);
};

Backbone.Model.prototype.enableQueue = function() {
    // queues can only be enabled once per model as they override some
    // backbone methods, doing this multiple times would cause all
    // kinds of havoc.
    if (this._backbone_queue_enabled) return;
    this._backbone_queue_enabled = true;

    // delta is used as a scratch pad for keeping track of 
    // all the changes made to a model in between saves
    var delta = {};

    // override the backbone save and destroy methods to allow us to track
    // when a server operation completes successfully (at which point any
    // pending changes can be removed from the persistent storage)
    var _save = this.save;
    this.save = function(key, val, options) {
        var model = this;
        var attrs;
        if (key == null || typeof key === 'object') {
            attrs = key;
            options = val;
        } else (attrs = {})[key] = val;
        options = options || {};
        // make sure values passed into save directly get a chance to propagate
        // through the change events and into the delta object before saving the 
        // delta object to storage
        this.set(attrs);

        // take a copy of what should be saved into the state 
        // by this call to save()
        var changesSinceLastSave = _.clone(delta);

        // if the model has not yet been saved to the server at all
        // then we shouldn't store any changes here as we need the model
        // to have an ID in order to know which model stored changes 
        // should be applied to
        if (this.isNew()) {
            if (model.get(model.cidAttribute)) {
                Store.save(model.pendingNewModelStorageKey(), model.toJSON());
            }
        } else {
            // if a delta actually exists, i.e. not an empty object
            // then serialise this to storage 
            if (Object.keys(changesSinceLastSave).length) {
                Store.save(model.pendingChangesStorageKey('update'), delta);
                // clear the current delta to start building up changes until
                // the next attempted save. if this save fails then we'll 
                // merge these changes back into to delta object so they'll 
                // get retried next time
                delta = {};
            }
        }


        // tap the success callback
        var _success = options.success;
        options.success = function() {
            var args = arguments;
            // removed locally saved record of changes as they're
            // now part of the server state
            Store.delete(model.pendingNewModelStorageKey()).then(function() {
                Store.delete(model.pendingChangesStorageKey('update'))
                    .then(function() {
                        if (_success) _success.apply(this, args);                 
                    }.bind(this));                
            }.bind(this));
        }

        // tap error callback
        var _error = options.error;
        options.error = function() {
            // order is important here as newer changes in delta
            // should always be applied on top of the changes in the
            // current batch that failed to save
            delta = _.extend({}, changesSinceLastSave, delta);
            if (_error) _error.apply(this, arguments);
        }

        // delegate back to backbone to do the heavy lifting
        // of updating the server
        return _save.call(this, attrs, options);
    }


    // override destroy method success callback to trigger events
    // that will allow for tracking of pending and successful 
    // model deletions
    var _destroy = this.destroy;
    this.destroy = function(options) {
        var model = this;
        if (!options) options = {};
        var collection = model.collection;
        if (collection) collection.trigger('destroy_start', model);
        var _success = options.success;
        options.success = function() {
            // clear any pending updates for the destroyed model when 
            // deletion has been successful
            Store.delete(model.pendingChangesStorageKey('update')).then(function() {
                if (collection) collection.trigger('destroy_success', model);
                if (_success) _success.apply(this, arguments);
            });
        }
        return _destroy.call(this, options);
    }

    // when a change is detected on a model we keep a in-memory note
    // of all changes (merged into a single diff). when save is called
    // this is what will be serialised to the persistent storage and 
    // hopefully the server at some point
    this.on('change', function(model, options) {
        if (options.unset) delta = _.omit(delta, _.keys(model.changedAttributes()));
        else delta = _.extend(delta, model.changedAttributes());
    });

};

Backbone.Model.prototype.processQueue = function(callback) {
    this.enableQueue();

    // once we've overridden the functions that track the save process
    // we can try to re-apply any offline changes, first to the model
    // and then try to save them to server 
    // if the save fails, the changes will still reside in the delta
    // object (and any further changes will be merged in). the changes
    // will be picked up next time a save attempt is made on the model
    Store.get(this.pendingNewModelStorageKey()).then(function(newModel){
        Store.get(this.pendingChangesStorageKey('update')).then(function(updatedValues){
            var value = {};
            value = _.extend(value, newModel);
            value = _.extend(value, updatedValues);
            if (value && Object.keys(value).length) {
                this.save(value, {
                    success: function() { callback(); },
                    error: function() { callback(); }
                });
            } else callback();
        }.bind(this));
    }.bind(this));
};






Backbone.Collection.prototype.enableQueue = function() {
    // queues can only be enabled once per model as they override some
    // backbone methods, doing this multiple times would cause all
    // kinds of havoc.
    if (this._backbone_queue_enabled) return;
    this._backbone_queue_enabled = true;
    this._pending_model_destroy_queue = [];

    // propagate queuing down to models in the collection
    // for existing models and all future models
    this.on('add', function(model){ model.enableQueue(); });
    this.each(function(model){ model.enableQueue(); });

    // attach events emitted by models that allow us to track
    // the progress of model destruction
    // when a deletion is started the model ID is added to a 
    // list of pending deletions.
    this.on('destroy_start', function(model) {
        var pending_destroy = this._pending_model_destroy_queue;
        pending_destroy = _.union(pending_destroy, [model.id]);
        this._pending_model_destroy_queue = pending_destroy;
        Store.save(this.pendingChangesStorageKey('destroy'), { destroy_queue: pending_destroy });
    }.bind(this));
    // once the server responds with a success status then 
    // the id is removed from the list
    this.on('destroy_success', function(model) {
        var pending_destroy = this._pending_model_destroy_queue;
        pending_destroy = _.without(pending_destroy, model.id);
        this._pending_model_destroy_queue = pending_destroy;
        if (pending_destroy.length)
            Store.save(this.pendingChangesStorageKey('destroy'), { destroy_queue: pending_destroy });
        else Store.delete(this.pendingChangesStorageKey('destroy'));
    });

    // once the model exists in the collection 
    // the corresponding cid id is removed from the list
    this.on('add sync change', function(model) {
        if (!(model instanceof Backbone.Model)) return;
        if (model.isNew()) return;
        var cid = model.get(model.cidAttribute);
        if (!cid) return;
        var pending_create = this._pending_model_create_queue || [];
        pending_create = _.without(pending_create, cid);
        this._pending_model_create_queue = pending_create;
        if (pending_create.length)
            Store.save(this.pendingChangesStorageKey('create'), { create_queue: pending_create });
        else Store.delete(this.pendingChangesStorageKey('create'));
    }.bind(this));

    var _create = this.create;
    this.create = function(model, options) {
        model = this._prepareModel(model, options);
        // ensure client id attribute is set (this is different to
        // backbones own cid property on models)
        var cid = model.get(model.cidAttribute) || uuid.v4();
        model.set(model.cidAttribute, cid);

        // make sure the model is offline-enabled
        model.enableQueue();

        // add client id to list of models to be created
        var pending_create = this._pending_model_create_queue || [];
        pending_create = _.union(pending_create, [cid]);
        this._pending_model_create_queue = pending_create;
        Store.save(this.pendingChangesStorageKey('create'), { create_queue: pending_create });
        return _create.call(this, model, options);
    }
};

// this is the function that does the work to restore any changes
// saved into the persistent storage to the model and save the 
// model back to the server
// deletions, creations and updates are treated separately
Backbone.Collection.prototype.processQueue = function(callback) {
    this.enableQueue();

    var collection = this;

    // destructions are stored as a list of IDs, so load the IDs
    // and try to restore the models if they're still in the collections
    // otherwise silently create a new model in the collection and 
    // then trigger a destruction
    var processDestructions = function(callback) {
        Store.get(this.pendingChangesStorageKey('destroy')).then(function(value){
            this._pending_model_destroy_queue = (value && value.destroy_queue) || [];
            async.map(this._pending_model_destroy_queue, function(id, cb){
                // if the model still exists in the collection then we can use this
                // object to trigger the destruction call
                var model = this.get(id);
                // otherwise we need to construct a dummy object to represent the model
                // being deleted
                if (!model) {
                    var doc = {};
                    doc[collection.model.prototype.idAttribute] = id;
                    model = collection.add(doc, { silent: true });
                }

                model.destroy({
                    success: function() { cb(); },
                    error: function() { cb(); }
                });
            }.bind(this), function() {
                callback();
            });
        }.bind(this));
    }.bind(this);

    // creations are stored as a list of IDs, the ids reference a full set of 
    // attributes for that should be created. The model is restored and then
    // saved to the server in the saveModelChanges step by calling processQueue 
    // on the model.
    var processCreations = function(callback) {
        Store.get(this.pendingChangesStorageKey('create')).then(function(value){
            this._pending_model_create_queue = (value && value.create_queue) || [];            
            async.map(this._pending_model_create_queue, function(id, cb){
                // create a dummy object that contains the client generated id
                // of the object, from which the rest of the object will be 
                // loaded and then saved to the server
                var doc = {};
                doc[collection.model.prototype.cidAttribute] = id;
                // add the model to the collection but don't save it yet
                // that will be done in the next phase where all pending
                // updates are applied to both saved and unsaved models
                collection.add(doc);
                cb();
            }, function(){
                callback();   
            });
        }.bind(this));
    }.bind(this);

    // for each model, load any changes stored in persistent storage
    // and trigger a save to either update or create the model.
    var saveModelChanges = function(callback) {
        async.map(this.models, function(model, cb) {
            model.processQueue(cb);
        }, callback);
    }.bind(this);

    processCreations(function() {
        saveModelChanges(function() {
            processDestructions(function() {
                callback();
            });
        });
    });
};
