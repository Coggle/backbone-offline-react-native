import Backbone from 'backbone-models-react-native';
import _ from 'underscore';
import Store from 'react-native-simple-store';
import async from 'async';

Backbone.Collection.prototype.pendingChangesStorageKey = 
Backbone.Model.prototype.pendingChangesStorageKey = function() {
    var prefix = Backbone.QUEUE_STORAGE_PREFIX ||
                 "backbone-queue-storage-";
    return prefix + _.result(this, 'url');
};

Backbone.Model.prototype.enableQueue = function(callback) {
    if (!callback) callback = function() {};

    // queues can only be enabled once per model as they override some
    // backbone methods, doing this multiple times would cause all
    // kinds of havoc.
    if (this._backbone_queue_enabled) return setTimeout(callback, 0);
    this._backbone_queue_enabled = true;

    // first step is to restore any previously queued values that 
    // save been saved into persistent storage
    // once that's done we override the backbone save and destroy
    // methods to allow us to track when a server operation completes
    // successfully (at which point the changes can be removed from 
    // the persistent storage)
    Store.get(this.pendingChangesStorageKey()).then(function(value){
        // all unsaved changes are stored in a temporary delta
        var delta = value || {};
        
        // override save method success callback so we know when 
        // cached changes have reached the server successfully 
        // and can then clear the local cache from the changes
        var _save = this.save;
        this.save = function(key, val, options) {
            var model = this;
            var attrs;
            if (key == null || typeof key === 'object') {
                attrs = key;
                options = val;
            } else {
                (attrs = {})[key] = val;
            }
            if (!options) options = {};

            // make sure values passed into save directly get a chance to propagate
            // through the change events and into the delta object before saving the 
            // delta object to storage
            this.set(attrs);

            // if a delta actually exists, i.e. not an empty object
            // then serialise this to storage 
            if (Object.keys(delta).length) {
                Store.save(model.pendingChangesStorageKey(), delta)
            }

            // tap the success callback
            var _success = options.success;
            options.success = function() {
                // removed locally saved record of changes as they're
                // now part of the server state
                Store.delete(model.pendingChangesStorageKey())
                    .then(function() {
                        delta = {};
                        if (_success) _success.apply(this, arguments);                    
                    });
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
                Store.delete(model.pendingChangesStorageKey()).then(function() {
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
            console.log('change', delta);
        });

        // once we've overridden the functions that track the save process
        // we can try ti re-apply any offline changes, first to the model
        // and then try to save them to server 
        // if the save fails, the changes will still reside in the delta
        // object (and any further changes will be merged in). the changes
        // will be picked up next time a save attempt is made on the model
        if (value) {
            this.save(delta, {
                success: function() { callback(); },
                error: function() { callback(); }
            });
        } else callback();
    }.bind(this));
};


Backbone.Collection.prototype.enableQueue = function(callback) {
    this._pending_model_destroy_queue = [];

    // propagate queuing down to models in the collection
    // for existing models and all future models
    this.on('add', function(model){ model.enableQueue(); });
    async.each(this, function(model, cb){
        model.enableQueue(cb);
    }, function() {
        this.processQueue(callback);
    }.bind(this));

    // attach events emitted by models that allow us to track
    // the progress of model destruction
    // when a deletion is started the model ID is added to a 
    // list of pending deletions.
    this.on('destroy_start', function(model) {
        var pending_destroy = this._pending_model_destroy_queue;
        pending_destroy = _.union(pending_destroy, [model.id]);
        this._pending_model_destroy_queue = pending_destroy;
        Store.save(this.pendingChangesStorageKey(), { destroy_queue: pending_destroy });
    }.bind(this));
    // once the server responds with a success status then 
    // the id is removed from the list
    this.on('destroy_success', function(model) {
        var pending_destroy = this._pending_model_destroy_queue;
        pending_destroy = _.without(pending_destroy, model.id);
        this._pending_model_destroy_queue = pending_destroy;
        if (pending_destroy.length)
            Store.save(this.pendingChangesStorageKey(), { destroy_queue: pending_destroy });
        else Store.delete(this.pendingChangesStorageKey());
    });
};


Backbone.Collection.prototype.processQueue = function(callback) {
    var collection = this;
    Store.get(this.pendingChangesStorageKey()).then(function(value){        this._pending_model_destroy_queue = (value && value.destroy_queue) || [];
        this._pending_model_destroy_queue.map(function(id){
            var model = this.get(id);
            // if the model still exists in the collection then we can use this
            // object to trigger the destruction call
            if (model) model.destroy();
            // otherwise we need to construct a dummy object to represent the model
            // being deleted
            else {
                var doc = {};
                doc[collection.model.prototype.idAttribute] = id;
                var model = collection.add(doc, { silent: true });
                model.destroy();
            }
        }.bind(this));
        callback();
    }.bind(this));
};

