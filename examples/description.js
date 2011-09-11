var upnp = require('../'), inspect = require('util').inspect;
/**
 * Load the description of the first found UPnP device.
 */
cp = new upnp.ControlPoint();
cp.once('DeviceFound', function(msg) {
  cp.loadDeviceDescription(msg.location, function(err, description) {
    console.log(inspect(err || description, true, 10, true))
    cp.close();
  });
});
cp.search();