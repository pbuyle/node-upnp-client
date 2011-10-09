var url     = require("url");
var http    = require("http");
var dgram   = require("dgram");
var util    = require("util");
var events  = require("events");
var expat = require('node-expat');

// SSDP
const SSDP_PORT = 1900;
const BROADCAST_ADDR = "239.255.255.250";
const SSDP_MSEARCH   = "M-SEARCH * HTTP/1.1\r\nHost:"+BROADCAST_ADDR+":"+SSDP_PORT+"\r\nST:%st\r\nMan:\"ssdp:discover\"\r\nMX:3\r\n\r\n";
const SSDP_ALIVE = 'ssdp:alive';
const SSDP_BYEBYE = 'ssdp:byebye';
const SSDP_UPDATE = 'ssdp:update';
const SSDP_ALL = 'ssdp:all';

const SCHEMAS_UPNP_ORG = 'schemas-upnp-org';

// RegExp
const RE_DEVICE_TYPE = /urn:([^:]+):device:([^:]+):([1-9][0-9]*)/;
const RE_SERVICE_TYPE = /urn:([^:]+):service:([^:]+):([1-9][0-9]*)/;

// Map SSDP notification sub type to emitted events 
const UPNP_NTS_EVENTS = {
  'ssdp:alive': 'DeviceAvailable',
  'ssdp:byebye': 'DeviceUnavailable',
  'ssdp:update': 'DeviceUpdate'
};

var debug;
if (process.env.NODE_DEBUG && /upnp/.test(process.env.NODE_DEBUG)) {
  debug = function(x) { console.error('UPNP: %s', x); };

} else {
  debug = function() { };
}



function ControlPoint() {
  events.EventEmitter.call(this);
  this.server = dgram.createSocket('udp4');
  this.server.addMembership(BROADCAST_ADDR);
  var self = this;
  this.server.on('message', function(msg, rinfo) {self.onRequestMessage(msg, rinfo);});
  this._initParsers();
  this.server.bind(SSDP_PORT);
}
util.inherits(ControlPoint, events.EventEmitter);
exports.ControlPoint = ControlPoint;

/**
 * Message handler for HTTPU request.
 */
ControlPoint.prototype.onRequestMessage = function(msg, rinfo) {
  var ret = this.requestParser.execute(msg, 0, msg.length);
  if (!(ret instanceof Error)) {
    var req = this.requestParser.incoming;
    switch (req.method) {
      case 'NOTIFY':
        debug('NOTIFY ' + req.headers.nts + ' NT=' + req.headers.nt + ' USN=' + req.headers.usn);
        var event = UPNP_NTS_EVENTS[req.headers.nts];
        if (event) {
          this.emit(event, req.headers);
        }
        break;
    };
  }
};

/**
 * Message handler for HTTPU response.
 */
ControlPoint.prototype.onResponseMessage = function(msg, rinfo){
  var ret = this.responseParser.execute(msg, 0, msg.length);
  if (!(ret instanceof Error)) {
    var res = this.responseParser.incoming;
    if (res.statusCode == 200) {
      debug('RESPONSE ST=' + res.headers.st + ' USN=' + res.headers.usn);
      this.emit('DeviceFound', res.headers);
    }
  }
}

/**
 * Initialize HTTPU response and request parsers.
 */
ControlPoint.prototype._initParsers = function() {
  var self = this;
  if (!self.requestParser) {
    self.requestParser = http.parsers.alloc();
    self.requestParser.reinitialize('request');
    self.requestParser.onIncoming = function(req) {

    };
  }
  if (!self.responseParser) {
    self.responseParser = http.parsers.alloc();
    self.responseParser.reinitialize('response');
    self.responseParser.onIncoming = function(res) {

    };
  }
};

/**
 * Send an SSDP search request.
 * 
 * Listen for the <code>DeviceFound</code> event to catch found devices or services.
 * 
 * @param String st
 *  The search target for the request (optional, defaults to "ssdp:all"). 
 */
ControlPoint.prototype.search = function(st) {
  if (typeof st !== 'string') {
    st = SSDP_ALL;
  }
  var message = new Buffer(SSDP_MSEARCH.replace('%st', st), "ascii");
  var client = dgram.createSocket("udp4");
  client.bind(); // So that we get a port so we can listen before sending
  // Set a server to listen for responses
  var server = dgram.createSocket('udp4');
  var self = this;
  server.on('message', function(msg, rinfo) {self.onResponseMessage(msg, rinfo);});
  server.bind(client.address().port);

  // Broadcast request
  client.send(message, 0, message.length, SSDP_PORT, BROADCAST_ADDR);
  debug('REQUEST SEARCH ' + st);
  client.close();

  // MX is set to 3, wait for 1 additional sec. before closing the server
  setTimeout(function(){
    server.close();
  }, 4000);
}

/**
 * Load a device description.
 * 
 * @param location
 *   The URL for the device description to load. Can be a string or a parsed URL object.
 * @param callback
 *   Callback function invoke on error or when the description is fully loaded.
 *
 * TODO: Move parsing in a separated function to allow testing.
 */
ControlPoint.loadDeviceDescription = function(location, callback) {
  if (typeof location !== 'object') {
    location = url.parse(location);
  }
  if (location.protocol !== 'http:' && location.protocol !== 'https:') {
    callback(new Error('Invalid device description location, only HTTP and HTTPS are supported.'));
  } else {
    location.port = location.port || (location.protocol == "https:" ? 443 : 80);
    // Retrieve device/service description
    var client = http.createClient(location.port, location.hostname);
    var request = client.request("GET", location.pathname, {
      "Host": url.hostname
    });
    request.addListener('response', function (response) {
      if (response.statusCode !== 200) {
        callback(new Error("Unexpected response status code: " + response.statusCode));
      }
      var deviceDescription = null;
      var parser = new expat.Parser('UTF-8');
      var properties = [];
      var scopes = [];
      var values = [];
      var urls = [];
      var baseUrl = location;
      parser.on('startElement', function(name, attrs) {
        switch(name) {
          case 'deviceType':
          case 'presentationURL':
          case 'friendlyName':
          case 'manufacturer':
          case 'manufacturerURL':
          case 'modelDescription':
          case 'modelName':
          case 'modelNumber':
          case 'serialNumber':
          case 'UDN':
          case 'serviceType':
          case 'serviceId':
          case 'SCPDURL':
          case 'controlURL':
          case 'eventSubURL':
          case 'mimetype':
          case 'width':
          case 'height':
          case 'depth':
          case 'url':
            properties.push(name);
            values.push('');
            break;
          case 'serviceList':
          case 'iconList':
            properties.push(name.replace('List', 's'));
            scopes.push([]);
            break;
          case 'icon':
          case 'service':
            properties.push(scopes[scopes.length-1].length);
            scopes.push({});
            break;
          case 'device':
            scopes.push({});
            break;
          case 'baseUrl':
            values.push('');
            break;
        }
      });
      parser.on('text', function(text){
        values[values.length-1] += text;
      });
      parser.on('endElement', function(name) {
        switch(name) {
          case 'deviceType':
            var property = properties.pop();
            var value = DeviceType.get(values.pop());
            scopes[scopes.length-1][property] = value;
            break;
          case 'serviceType':
            var property = properties.pop();
            var value = ServiceType.get(values.pop());
            scopes[scopes.length-1][property] = value;
            break;
          case 'friendlyName':
          case 'manufacturer':
          case 'modelDescription':
          case 'modelName':
          case 'modelNumber':
          case 'serialNumber':
          case 'UDN':
          
          case 'serviceId':
          case 'mimetype':
          case 'width':
          case 'height':
          case 'depth':
            var property = properties.pop();
            var value = values.pop();
            scopes[scopes.length-1][property] = value;
            break;
          case 'presentationURL':
          case 'manufacturerURL':
          case 'SCPDURL':
          case 'controlURL':
          case 'eventSubURL':
          case 'url':
            var property = properties.pop();
            var value = url.parse(values.pop());
            urls.push(value);
            scopes[scopes.length-1][property] = value;
            break;
          case 'service':
            var property = properties.pop();
            var value = scopes.pop();
            scopes[scopes.length-1][property] = new Service(value);
            break;
          case 'serviceList':
          case 'icon':
          case 'iconList':
            var property = properties.pop();
            var value = scopes.pop();
            scopes[scopes.length-1][property] = value;
            break;
          case 'device':
            deviceDescription = scopes.pop();
            break;
          case 'baseUrl':
            baseUrl= url.parse(values.pop());
        }
      });
      response.on('data', function (chunk) {
        if (!parser.parse(chunk, false)) {
          callback(new Error(parser.getError()));
          parser.stop();
          response.destroy();
        }
      });
      response.setEncoding("utf8");
      response.on("end", function() {
        if (!parser.parse('', true)) {
          callback(new Error(parser.getError()));
          parser.stop();
          response.destroy();
        } else {
          var urlIndex = urls.length;
          while(urlIndex--) {
            urls[urlIndex].__proto__ = baseUrl;
          }
          if (deviceDescription) {
            callback(null, deviceDescription);
          } else {
            callback(new Error("Incomplete device description."));
          }
        }
      });
    });
    request.end();
    debug('HTTP request ' + location.href);
  }
}

/**
 * Terminates this ControlPoint.
 */
ControlPoint.prototype.close = function() {
  this.server.close();
  http.parsers.free(this.requestParser);
  http.parsers.free(this.responseParser);
}

/**
 * An UPNP device.
 */
Device = function(location) {
  this.location = location;
}
exports.Device = Device;

Device.prototype.loadDescription = function(callback) {
  var self = this;
  ControlPoint.loadDeviceDescription(self.location, function(err, description){
    if (!err && typeof description === 'object') {
      for (p in description) {
        if (description.hasOwnProperty(p)) {
          self[p] = description[p];
        }
      }
    }
    callback(err, self);
  });
}

/**
 * An UPNP service
 */
Service = function(properties) {
  for (p in properties) {
    if (properties.hasOwnProperty(p)) {
      this[p] = properties[p];
    }
  }
}

Service.prototype.loadDescription = function(callback) {
  callback(undefined, this);
}

/**
 * An UPNP device type.
 */
DeviceType = function(deviceType, version, domain) {
  if (!domain) {
    domain = SCHEMAS_UPNP_ORG;
  }
  this.deviceType = deviceType;
  this.version = version;
  this.domain = domain;
}
DeviceType.prototype.toString = function() {
  return 'urn:' + this.domain + ':device:' + this.deviceType + ':' + this.version;
}
/**
 * Known instances of DeviceType
 */
DeviceType.instances = {};
/**
 * Factory to create and retrieve shared DeviceType instances.
 */
DeviceType.get = function(str) {
  if (!DeviceType.instances[str]) {
    var matches = RE_DEVICE_TYPE.exec(str);
    if (!matches) {
      throw new Error('Invalid device type: ' + str);
    }
    DeviceType.instances[str] = new DeviceType(matches[2], parseInt(matches[3]), matches[1]);
  }
  return DeviceType.instances[str];
}

/**
 * An UPNP service type.
 */
ServiceType = function(serviceType, version, domain) {
  if (!domain) {
    domain = SCHEMAS_UPNP_ORG;
  }
  this.serviceType = deviceType;
  this.version = version;
  this.domain = domain;
}
ServiceType.prototype.toString = function() {
  return 'urn:' + this.domain + ':service:' + this.serviceType + ':' + this.version;
}
/**
 * Known instances of DeviceType
 */
ServiceType.instances = {};
/**
 * Factory to create and retrieve shared ServiceType instances.
 */
ServiceType.get = function(str) {
  if (!ServiceType.instances[str]) {
    var matches = RE_SERVICE_TYPE.exec(str);
    if (!matches) {
      throw new Error('Invalid service type: ' + str);
    }
    ServiceType.instances[str] = new ServiceType(matches[2], parseInt(matches[3]), matches[1]);
  }
  return ServiceType.instances[str];
}

/* TODO Move these stuff to a separated module/project */

//some const strings - dont change
const GW_ST    = "urn:schemas-upnp-org:device:InternetGatewayDevice:1";
const WANIP = "urn:schemas-upnp-org:service:WANIPConnection:1";
const OK    = "HTTP/1.1 200 OK";
const SOAP_ENV_PRE = "<?xml version=\"1.0\"?>\n<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>";
const SOAP_ENV_POST = "</s:Body></s:Envelope>";

function searchGateway(timeout, callback) {
  var devices = {};
  var t;
  
  if (timeout) {
    t = setTimeout(function() {
      callback(new Error("searchGateway() timed out"));
    }, timeout);
  }
  
  var cp = new ControlPoint();
  cp.once('DeviceFound', function(headers) {
    var l = url.parse(headers.location);
    l.port = l.port || (l.protocol == "https:" ? 443 : 80);
    // Early return if this location is already processed 
    if (devices[l.href]) return;

    // Retrieve device/service description
    var device = devices[l.href] = new Device(l);
    device.loadDescription(function(err, device){
      if (err) {
        callback(err, device);
        return
      }
      var serviceIdx = device.services.length;
      while(serviceIdx--) {
        var service = device.services[serviceIdx];
        if (service.serviceType == GW_ST) {
          callback(null, new Gateway(service.controlUrl.port, service.controlUrl.hostname, service.controlUrl.pathname));
        }
      }
    });
  });
  
  cp.search(GW_ST);
}
exports.searchGateway = searchGateway;

function Gateway(port, host, path) {
  this.port = port;
  this.host = host;
  this.path = path;
}

// Retrieves the values of the current connection type and allowable connection types.
Gateway.prototype.GetConnectionTypeInfo = function(callback) {
  this._getSOAPResponse(
    "<u:GetConnectionTypeInfo xmlns:u=\"" + WANIP + "\">\
    </u:GetConnectionTypeInfo>",
    "GetConnectionTypeInfo",
    function(err, response) {
      if (err) return callback(err);
      var rtn = {};
      try {
        rtn['NewConnectionType'] = this._getArgFromXml(response.body, "NewConnectionType", true);
        rtn['NewPossibleConnectionTypes'] = this._getArgFromXml(response.body, "NewPossibleConnectionTypes", true);
      } catch(e) {
        return callback(e);
      }
      callback.apply(null, this._objToArgs(rtn));
    }
  );
}

Gateway.prototype.GetExternalIPAddress = function(callback) {
  this._getSOAPResponse(
    "<u:GetExternalIPAddress xmlns:u=\"" + WANIP + "\">\
    </u:GetExternalIPAddress>",
    "GetExternalIPAddress",
    function(err, response) {
      if (err) return callback(err);
      var rtn = {};
      try {
        rtn['NewExternalIPAddress'] = this._getArgFromXml(response.body, "NewExternalIPAddress", true);
      } catch(e) {
        return callback(e);
      }
      callback.apply(null, this._objToArgs(rtn));
    }
  );
}

Gateway.prototype.AddPortMapping = function(protocol, extPort, intPort, host, description, callback) {
  this._getSOAPResponse(
    "<u:AddPortMapping \
    xmlns:u=\""+WANIP+"\">\
    <NewRemoteHost></NewRemoteHost>\
    <NewExternalPort>"+extPort+"</NewExternalPort>\
    <NewProtocol>"+protocol+"</NewProtocol>\
    <NewInternalPort>"+intPort+"</NewInternalPort>\
    <NewInternalClient>"+host+"</NewInternalClient>\
    <NewEnabled>1</NewEnabled>\
    <NewPortMappingDescription>"+description+"</NewPortMappingDescription>\
    <NewLeaseDuration>0</NewLeaseDuration>\
    </u:AddPortMapping>",
    "AddPortMapping",
    function(err, response) {
      if (err) return callback(err);
    }
  );
}

Gateway.prototype._getSOAPResponse = function(soap, func, callback) {
  var self = this;
  var s = new Buffer(SOAP_ENV_PRE+soap+SOAP_ENV_POST, "utf8");
  var client = http.createClient(this.port, this.host);
  var request = client.request("POST", this.path, {
    "Host"           : this.host + (this.port != 80 ? ":" + this.port : ""),
    "SOAPACTION"     : '"' + WANIP + '#' + func + '"',
    "Content-Type"   : "text/xml",
    "Content-Length" : s.length
  });
  request.addListener('error', function(error) {
    callback.call(self, error);
  });
  request.addListener('response', function(response) {
    if (response.statusCode === 402) {
      return callback.call(self, new Error("Invalid Args"));
    } else if (response.statusCode === 501) {
      return callback.call(self, new Error("Action Failed"));      
    }
    response.body = "";
    response.setEncoding("utf8");
    response.addListener('data', function(chunk) { response.body += chunk });
    response.addListener('end', function() {
      callback.call(self, null, response);
    });
  });
  request.end(s);
}

// Formats an Object of named arguments, and returns an Array of return
// values that can be used with "callback.apply()".
Gateway.prototype._objToArgs = function(obj) {
  var wrapper;
  var rtn = [null];
  for (var i in obj) {
    if (!wrapper) {
      wrapper = new (obj[i].constructor)(obj[i]);
      wrapper[i] = obj[i];
      rtn.push(wrapper);
    } else {
      wrapper[i] = obj[i];
      rtn.push(obj[i]);
    }
  }
  return rtn;
}

Gateway.prototype._getArgFromXml = function(xml, arg, required) {
  var match = xml.match(new RegExp("<"+arg+">(.+?)<\/"+arg+">"));
  if (match) {
    return match[1];
  } else if (required) {
    throw new Error("Invalid XML: Argument '"+arg+"' not given.");
  }
}
