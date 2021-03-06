define([
	"dijit/_WidgetBase",
	"dojo/Evented", 
    "dojo/_base/declare",
    "dojo/_base/lang",
	"dojo/_base/array",
    "dojo/parser",
    "dijit/_TemplatedMixin",
	"dijit/_WidgetsInTemplateMixin", 

    "dojo/on",
	"dojo/dom",
    "dojo/dom-construct",
    "dojo/dom-class",
    "dojo/dom-style",
    "dojo/ready",
	
	"dojo/store/Memory",
	"dijit/form/ComboBox", 
	
	"esri/geometry/webMercatorUtils",
	"esri/tasks/ProjectParameters",
    "esri/tasks/GeometryService", 	
    "esri/layers/GraphicsLayer",
	"esri/geometry/Extent",
    "esri/geometry/Point",
    "esri/graphic",	
	"esri/SpatialReference",
	"esri/symbols/PictureMarkerSymbol",
	"esri/symbols/SimpleMarkerSymbol", 

	"dojo/text!apc/dijit/templates/ZoomToPoint.html"
], function(
	_WidgetBase, Evented, 
	declare, lang, array, parser, _TemplatedMixin, _WidgetsInTemplateMixin, 
	on, dom, domConstruct, domClass, domStyle, ready, 
	Memory, ComboBox, 
	webMercatorUtils, ProjectParameters, GeometryService, 
	GraphicsLayer, Extent, Point, Graphic, SpatialReference,
	PictureMarkerSymbol, SimpleMarkerSymbol,
    dijitTemplate
){
	var zoomToPoint = declare("ZoomToPoint", 
			[_WidgetBase, _TemplatedMixin, _WidgetsInTemplateMixin, Evented], {
		
		templateString: dijitTemplate,
		
		options: {
			map: null, // required
			precision: 7, 
			geometryService: null, 
			coordSysOptions: [
				{name:"WGS84", wkid:4326},
				{name:"NAD83", wkid:4269},
				{name:"NAD27", wkid:4267}
			], 
			markerSymbol: {
				"type": "esriSMS",
				"style": "esriSMSX",
				"color": [255,0,0,255],
				"size": 8,
				"angle": 0,
				"xoffset": 0,
				"yoffset": 0,
				"outline": {
					"color": [255,0,0,255],
					"width": 2
				}
			},
			visible: true
		}, 
		
        /* ----------------- */
        /* Public Variables  */
        /* ----------------- */
		
		storedPoints: [],
		
		
        /* ------------------ */
        /* Private Variables  */
        /* ------------------ */
		_css: {
			title: "pointZoom-inputTitle", 
			help: "pointZoom-helpText",
			coordsInput: "pointZoom-CoordsInput",
			dropdownList: "pointZoom-DropdownList",
			zoomToOne: "pointZoom-zoomToOne",
			pointListContainer: "pointZoom-pointListContainer",
			clearAll: "pointZoom-clearAll",
			zoomToAll: "pointZoom-zoomToAll",
			saveAll: "pointZoom-saveAll", 
			pointList: "pointZoom-pointList",
			pointItem: "pointZoom-pointItem",
			statusMessage: "pointZoom-status"
		}, 
		
		_layerIdPrefix: "PointZoom_",
		_bufferRadius: 0.0005,
		
		_coordRegEx: {
			dms: /^([+-]|[NSEW])?\d{1,3}(\.\d+)?\*?(\s+\d{1,2}(\.\d+)?'?(\s+\d{1,2}(\.\d+)?"?)?)?[NSEW]?$/i,
			dd:  /^[+-]?\d{1,3}(\.\d+)?$/i,
			xy:  /^[+-]?\d+(\.\d+)?$/i
		},

		_srWGSWkids: [4326, 4269, 4267],
		_selectedWkid: null,

		_pointLayer: null, 
		_extent: null, 
		_inputValidated: false, 
		
		
        /* ---------------- */
        /* Class Functions  */
        /* ---------------- */
		constructor: function(options, srcRefNode) {
			declare.safeMixin(this.options, options); 
			
			this.set("map", this.options.map); 
			this.set("precision", this.options.precision); 
			this.set("geometryService", this.options.geometryService); 
			this.set("coordSysOptions", this.options.coordSysOptions); 
			this.set("markerSymbol", this.options.markerSymbol); 
			this.set("visible", this.options.visible); 
			// derived
			if (this.markerSymbol) {
				switch(this.markerSymbol["type"]) {
					case "esriPMS": 
						this.set("_pointSymbol", new PictureMarkerSymbol(this.markerSymbol));
						break;
					case "esriSMS": 
					default:
						this.set("_pointSymbol", new SimpleMarkerSymbol(this.markerSymbol));
				}
			}
			// listeners
            this.watch("visible", this._visible);
		}, 

		startup: function () {
            // map not defined
            if (!this.map) {
              this.destroy();
              console.log('ZoomToPoint::map required');
            }
            // when map is loaded
            if (this.map.loaded) {
              this._init();
            } else {
              on(this.map, "load", lang.hitch(this, function () {
                this._init();
              }));
            }
        },

        // connections/subscriptions will be cleaned up during the destroy() lifecycle phase
        destroy: function () {
            this.inherited(arguments);
        },

        /* ------------------------- */
        /* Private Utility Functions */
        /* ------------------------- */

        _init: function () {
			// populate the combobox store
			var coordSysStore = new Memory({
				data: {
					identifier: 'wkid',
					label: "name",
					items: this.coordSysOptions
				}
			});
			this._coordSysComboBox.set("store", coordSysStore); 
			if (this.coordSysOptions && this.coordSysOptions[0]) {
				var firstOption = this.coordSysOptions[0];
				this._coordSysComboBox.set("value", firstOption["name"]); 
			}
			// 
			// not display the PointList container
			domStyle.set(this._pointListContainer, "display", "none");
			//
            this._visible();
            this.set("loaded", true);
            this.emit("load", {});
        },

        _visible: function () {
            if (this.get("visible")) {
                domStyle.set(this.domNode, 'display', 'block');
            } else {
                domStyle.set(this.domNode, 'display', 'none');
            }
        },

        /* ---------------------- */
        /* Private Event Handlers */
        /* ---------------------- */

		_coordSysChanged: function(evt) {
			//console.log("_coordSysChanged"); 
			this.showMessage("");

			this._selectedWkid = evt; 
			for(var i=0, l=this.coordSysOptions.length; i<l; i++) {
				var item = this.coordSysOptions[i]; 
				if (item["name"] === evt) {
					this._selectedWkid = item["wkid"]; 
					break; 
				}
			}

			var coordsInput = this._cleanCoords(this._coordsInput.value);
			if (coordsInput) {
				this._inputValidated = this._parseAndValidate(coordsInput, this._selectedWkid);
			}
		}, 

		_coordsChanged: function(evt) {
			//console.log("_coordsChanged"); 
			this.showMessage("");

			if ((evt.keyCode || evt.which) === 13 /* enter */) {
				this.zoomToOne(); 
			} else {			
				var coordsInput = this._cleanCoords(this._coordsInput.value);
				this._inputValidated = this._parseAndValidate(coordsInput, this._selectedWkid);
			}
		}, 
		
		_cleanCoords: function(coordsText) {
			//console.log("input coordsText = " + coordsText);
			if (coordsText) {
				var startIdx=0, endIdx=coordsText.length-1, c, l; 
				var regExp = /^[0-9\+\-\.NSEW]+$/i; 
				for(c=0,l=coordsText.length; c<l; c++) {
					if (coordsText[c].search(regExp) > -1) {
						startIdx = c; 
						break; 
					}
				}
				for(c=coordsText.length-1,l=0; c>=l; c--) {
					if (coordsText[c].search(regExp) > -1) {
						endIdx = c; 
						break; 
					}
				} 
				coordsText = coordsText.substring(startIdx, endIdx+1); 
			}
			//console.log("cleaned coordsText = " + coordsText);
			return coordsText; 
		}, 

		_convertDMS2Decimal: function(dmsText) {
			var result = {name: null, value: null}; 

			var dmsParts = dmsText.split(/[\s\*:'"]/); 
			if (dmsParts.length >= 1 && dmsParts.length <= 3) {
				var dirSignArray = ["N", "E", "W", "S"]; 
				var dirChar, dirSign; 
				var deg, min, sec; 

				deg = dmsParts[0].toUpperCase(); 
				if (dmsParts.length >= 2)
					min = dmsParts[1].toUpperCase();
				if (dmsParts.length >= 3)
					sec = dmsParts[2].toUpperCase();

				// find the dir char
				if (deg && array.indexOf(dirSignArray, deg[0]) > -1) {
					dirChar = deg[0]; 
					deg = deg.substr(1, deg.length-1); 
				} else if (deg && array.indexOf(dirSignArray, deg[deg.length-1]) > -1) {
					dirChar = deg[deg.length-1]; 
					deg = deg.substr(0, deg.length-1); 
				} else if (min && array.indexOf(dirSignArray, min[min.length-1]) > -1) {
					dirChar = min[min.length-1]; 
					min = min.substr(0, min.length-1);
				} else if (sec && array.indexOf(dirSignArray, sec[sec.length-1]) > -1) {
					dirChar = sec[sec.length-1]; 
					sec = sec.substr(0, sec.length-1); 
				}

				// determine the lat/lon
				var valid = !isNaN(deg); 
				if (valid === true) {
					deg = Number(deg); 
					if (dirChar === "N" || dirChar === "S") {
						valid = (deg > -90 && deg < 90); 
						result["name"] = "lat";
						dirSign = (dirChar === "N")?1:-1; 
					} else if (dirChar === "E" || dirChar === "W") {
						valid = (deg > -180 && deg < 180); 
						result["name"] = "lon";
						dirSign = (dirChar === "E")?1:-1; 
					} else {
						valid = true; 
						dirSign = 1; 
						if (deg > -90 && deg < 90) {
							//result["name"] = "lat";
						} else if (deg > -180 && deg < 180) {
							result["name"] = "lon";
						} else {
							valid = false; 
						}
					}

					// calculate the coordinate
					var coord = dirSign * deg; 
					if (min) {
						min = Number(min); 
						valid = valid && (min >= 0 && min < 60); 
						if (valid === true) {
							coord = dirSign * (deg + (min/60)); 
							if (sec) {
								sec = Number(sec); 
								valid = valid && (sec >= 0 && sec < 60); 
								if (valid === true) {
									coord = dirSign * (deg + (min/60) + (sec/3600));
								}
							}
						}
					}
					result["value"] = coord.toFixed(Number(this.precision));
				}
			}
			return result;
		},

		_parseAndValidate: function(coordsText, wkid) {
			
			this._coordParseX.innerHTML = "";
			this._coordParseY.innerHTML = "";

			var coordArray = coordsText.split(/[,;\/\\|]+/); 

			if (coordArray.length === 1) {
				var coordParts = coordsText.split(/\s+/);
				if ( coordParts.length === 2) {
					coordArray = coordParts; 
				} else {
					coordArray = []; 				
					var dirIdx, item, coordIdx, cnt = 0; 
					for (var p=0, l=coordParts.length; p<l; p++) {
						item = coordParts[p]; 
						dirIdx = item.search(/[NSEW]/i); 
						if (dirIdx === 0 /*dir sign appears first*/) {
							// add new coord
							coordArray.push(item); 
							coordIdx = coordArray.length-1;
							cnt = 1; 
						} else if (dirIdx === item.length-1 /*dir sign appears last*/) {
							if (cnt === 0) {
								// prev is already full, so add new coord
								coordArray.push(item);
								coordIdx = coordArray.length-1;
								if (coordIdx === 1)
									cnt = 1; 
							} else {
								coordArray[coordIdx] += (" " + item);
								// reset the count
								cnt = 0; 
							}
						} else {
							if (cnt === 0) {
								coordArray.push(item); 
								coordIdx = coordArray.length-1;
							} else {
								coordArray[coordIdx] += (" " + item);
							}
							if (++cnt == 3) {
								cnt = 0; 
							}
						}
					}					
				}
			}
			
			if (coordArray.length === 2) {
				var coordX, coordY; 
				if (array.indexOf(this._srWGSWkids, wkid) > -1) {
					// input format: Lat, Lon
					coordX = coordArray[1].trim(); 
					coordY = coordArray[0].trim(); 

					if (this._coordRegEx["dms"].test(coordX) === true 
						&& this._coordRegEx["dms"].test(coordY) === true) {
						// DMS or DD format
						var results = []; 
						results.push(this._convertDMS2Decimal(coordX)); 
						results.push(this._convertDMS2Decimal(coordY));

						for(var c=0,l=results.length; c<l; c++) {
							var item = results[c]; 
							var other = results[(c+1)%2]; 

							if (item["name"] === "lat" || other["name"] === "lon") {
								this._coordParseY.innerHTML = item["value"];
							} else if (item["name"] === "lon" || other["name"] === "lat") {
								this._coordParseX.innerHTML = item["value"];
							} else {
								if (c === 0 && this._coordParseX.innerHTML.length === 0)
									this._coordParseX.innerHTML = item["value"];
								else if (this._coordParseY.innerHTML.length === 0)
									this._coordParseY.innerHTML = item["value"];
							}
						}; 
						return (this._coordParseX.innerHTML.length > 0 
								&& this._coordParseY.innerHTML.length > 0); 
					}

				} else {
					// input format: X, Y
					coordX = coordArray[0].trim(); 
					coordY = coordArray[1].trim(); 

					if (this._coordRegEx["xy"].test(coordX) === true 
						&& this._coordRegEx["xy"].test(coordY) === true) {
						// XY format
						this._coordParseX.innerHTML = coordX;
						this._coordParseY.innerHTML = coordY;
						return true; 
					}

				}
			}
			
			return false; 
		}, 

		_addPointToList: function(point) {
			this.storedPoints.push(point); 

			var pointItem = "<li class='" + this._css["pointItem"] + "'>" 
				+ Number(point.x).toFixed(this.precision) + ", " 
				+ Number(point.y).toFixed(this.precision) + "</li>"; 
			this._pointList.innerHTML += pointItem;

			if (domStyle.get(this._pointListContainer, "display") === "none") {
				domStyle.set(this._pointListContainer, "display", "block");
			}
		}, 

		_plotPointFailed: function(error) {
			var errMsg = error.message; 
			if (error.details && error.details[0]) {
				errMsg = error.details[0]; 
			}
			this.showMessage("projection failed: " + errMsg);
		},

		/*
		 * Plot a point executes the following sequences: 
		 * - if WGS84, plot the point on the map directly;
		 * - if NAD83, project to WGS84 first; 
		 * - if NAD27, project to NAD83 first; 
		 * - otherwise, project to NAD27 first; 
		 */
		_plotPoint: function(point) {
			if (point) {
				var sr = point.spatialReference; 
				if (sr && sr.wkid) {
					switch(sr.wkid) {
						case 4326 /* WGS84 */: 
							mapPoint = webMercatorUtils.geographicToWebMercator(point);
							if (! this._pointLayer) {
								this._pointLayer = new GraphicsLayer({id: this._layerIdPrefix + "0"}); 
								this.map.addLayer(this._pointLayer); 
							}
							if (mapPoint) {
								this._pointLayer.add(new Graphic(mapPoint, this._pointSymbol));
								this._zoomToPoint(mapPoint); 
								this._addPointToList(point); 
							}
							break; 
						case 4269 /* NAD83 */:
							var params = new ProjectParameters();
							params.geometries = [point];
							params.outSR = new SpatialReference({wkid: 4326 /* WGS84 */});
							params.transformation = {wkid: 108190};
							this.geometryService.project(params)
												.then(lang.hitch(this, function(projGeometries) {
													var projPoint = projGeometries[0];
													this._plotPoint(projPoint);
												}), lang.hitch(this, function(error) {
													this._plotPointFailed(error); 
												}));
							break;
						case 4267 /* NAD27 */: 
							var params = new ProjectParameters();
							params.geometries = [point];
							params.outSR = new SpatialReference({wkid: 4269 /* NAD83 */});
							params.transformation = {wkid: 1241};
							this.geometryService.project(params)
												.then(lang.hitch(this, function(projGeometries) {
													var projPoint = projGeometries[0];
													this._plotPoint(projPoint);
												}), lang.hitch(this, function(error) {
													this._plotPointFailed(error); 
												}));
							break;
						default:
							var params = new ProjectParameters();
							params.geometries = [point];
							params.outSR = new SpatialReference({wkid: 4267 /* NAD27 */});
							this.geometryService.project(params)
												.then(lang.hitch(this, function(projGeometries) {
													var projPoint = projGeometries[0];
													this._plotPoint(projPoint);
												}), lang.hitch(this, function(error) {
													this._plotPointFailed(error); 
												}));
					}					
				} else {
					this.showMessage("empty spatial reference"); 
				}
			} else {
				this.showMessage("empty point"); 
			}
		},

		_zoomToPoint: function(mapPoint) {
			if (mapPoint) {
				var pointExtent = new Extent(
						mapPoint.x - this._bufferRadius, mapPoint.y - this._bufferRadius, 
						mapPoint.x + this._bufferRadius, mapPoint.y + this._bufferRadius, 
						mapPoint.spatialReference); 

				if (this._extent) {
					this._extent = this._extent.union(pointExtent); 
				} else {
					this._extent = pointExtent; 
				}

				this.map.setExtent(pointExtent, true); 

				this.showMessage(""); 
				
				this.emit("zoom"); 
			} 			
		}, 

		_clearInput: function() {
			this._coordsInput.value = ""; 

			this._coordParseX.innerHTML = "";
			this._coordParseY.innerHTML = "";			
		}, 

        /* ----------------------- */
        /* Template Event Handlers */
        /* ----------------------- */

		zoomToOne: function() {
			if (this._inputValidated !== true) {
				this.showMessage("invalid coordinates"); 
				
			} else {
			
				var coordX = this._coordParseX.innerHTML,
					coordY = this._coordParseY.innerHTML;

				if (coordX.trim().length === 0 || coordY.trim().length === 0) {
					this.showMessage("invalid coordinates"); 
				} else {
					this.showMessage("Plotting point..."); 
					
					var wkid = this._selectedWkid; 
					
					if (this.markerSymbol) {
						switch(this.markerSymbol["type"]) {
							case "esriPMS": 
								this._pointSymbol = new PictureMarkerSymbol(this.markerSymbol);
								break;
							case "esriSMS": 
							default:
								this._pointSymbol = new SimpleMarkerSymbol(this.markerSymbol);
						}
					}
					
					var point = new Point(coordX, coordY, new SpatialReference({wkid: wkid}));
					this._plotPoint(point);
				}
			}
		}, 

		zoomToAll: function() {
			if (this._extent) {
				this.map.setExtent(this._extent, true); 
			}

			this.emit("zoomAll"); 
		},

		clearAll: function() {
			this._clearInput(); 
			this.showMessage(""); 
			
			domStyle.set(this._pointListContainer, "display", "none");

			if (this._pointLayer) {
				this._pointLayer.clear(); 
			}
			this._extent = null;  

			this._pointList.innerHTML = ""; 

			this.storedPoints = []; 

			this.emit("clearAll"); 
		}, 

		saveAll: function() {
			this.emit("saveAll-start", this.storedPoints); 
		}, 

		showMessage: function (message) {
            if (message) {
                /* limit the message size */
                message = message.substr(0, 100); 
            }
            this._status.innerHTML = message;
        }
	}); 

	ready(function() {
		console.log("The ZoomToPoint widget is ready!");
	}); 

	return zoomToPoint; 
}); 