/*global _epBridge  _epBridgeSend*/


/*
Message Formatting: (as JSON string)
{
  service: ‘string’,        // required
  action: ‘string’,         // required
  payload: Object | Array,  // optional
  meta: Object,             // optional
  token: ‘string’           // required when a response is expected (internal use only)
}
 */

import { processEvent } from './events';
import EnplugError from './errors/EnplugError';



// todo finish reject timeout
const RESPONSE_TIMEOUT = (60 * 1000);
const VERSION = '0.4.11';
var WHITELIST = [
  'http://apps.enplug.com',
  'http://apps.enplug.in',
  'http://dashboard.enplug.com',
  'http://dashboard.enplug.in',
  'http://dashboard.enplug.loc',
  'http://player.enplug.com',
  'http://player.enplug.in',
  'http://player.enplug.loc',
  'https://apps.enplug.com',
  'https://apps.enplug.in',
  'https://dashboard.enplug.com',
  'https://dashboard.enplug.in',
  'https://dashboard.enplug.loc',
  'https://player.enplug.com',
  'https://player.enplug.in',
  'https://player.enplug.loc'
];

var epBridge = null;
var responseMap = new Map();
var isZoningApp = false;
var delayedMessages = [];


/**
 * Creates a unique token used to identify apprpriate message response function.
 * @return {string} - A unique token.
 */
function createToken() {
  var token = Math.random().toString(36).substr(2);
  // Make sure a unique token is created. If created token already exists, create a different one.
  if (responseMap.has(token)) {
    return createToken();
  }
  return token;
}




// Check for the existence of the global bridge object. If it doesn't, create one so that it can
// send and receive messages from the Web Player.
try {
  isZoningApp = !!window.location.href && window.location.href.indexOf('zoning=true') >= 0;
  console.log(`[Player SDK: ${VERSION}] Zoning App detected: ${isZoningApp}`);
  let $global = Function('return this')(); // eslint-disable-line

  // _epBridge exists: Java Player
  if ($global.hasOwnProperty('_epBridge')) {
    console.log(`[Player SDK: ${VERSION}] Creating bridge from standard implementation.`);
    epBridge = $global._epBridge;
  }
  // _epBridge doesn't exist but _epBridgeSend exists: Windows (CEF) Player
  else if ($global.hasOwnProperty('_epBridgeSend')) {
    console.log(`[Player SDK: ${VERSION}] Creating bridge from CEF implementation.`, $global._epBridge);
    epBridge = $global._epBridge = {
      send(message) {
        $global._epBridgeSend({
          request: message,
          persistent: false
        });
      }
    };
  } else {
    epBridge =  _epBridge;
  }

} catch (error) {
  // epBridge was not found. In such case, we assume that the application is iframed within
  // WebPlayer and communication has to proceed via posting and receiving messages between windows.
  console.info(`[Player SDK: ${VERSION}] Initializing Web Development Player.`);

  epBridge = {
    send: (msg) => {
      const destinationMatch = window.location.href.match(/origin=(https?\:\/\/[a-z]*\.[a-z]*\.[a-z]{2,3})/);
      const destination = destinationMatch && destinationMatch[1];
      console.log(`[Player SDK: ${VERSION}] Validating destination ${destination} with the whitelist.`, destination);
      for (let whitelistedUrl of WHITELIST) {
        if (destination === whitelistedUrl) {
          console.log(`[Player SDK: ${VERSION}] Whitelist match found. Posting message.`, msg, destination);
          parent.postMessage(msg, destination);
        }
      }
    }
  };

  window.addEventListener('message', function (event) {
    // Prevent unnencessary loops/CPU usage if we're sure the request did not come from Enplug's server.
    // This is necessary to limit the influence of 3rd party websites which post messages multiple times per second.
    for (let whitelistedUrl of WHITELIST) {
      if (event.origin.startsWith(whitelistedUrl)) {
        console.log(`[Player SDK: ${VERSION}] Received message from ${event.origin}`, event);
        epBridge.receive(event.data);
      }
    }
  });
}



/*eslint no-implicit-globals: "off", no-unused-vars: "off" */
// global fn for Java bridge to call
epBridge.receive = function (json) {
  try {
    let data = {};

    if (typeof json === 'string') {
      data = JSON.parse(json);
    } else {
      data = json;
    }

    const isReload = data.action === 'reload';
    const isError = data.action === 'error';
    const service = data.service;
    const action = data.action;
    let payload = data.payload || {};
    const meta = data.meta || {};
    const token = data.token;

    console.log(`[Player SDK: ${VERSION}] Received message with action ${action}`, data);

    // if there is a token we can just resolve the promise and be done
    // if it was an error the payload has been transformed to an error
    //    so we can just reject the promise with that error
    if (token && responseMap.has(token)) {
      let responseFunctions = responseMap.get(token);
      responseFunctions[isError ? 1 : 0](payload);
      responseMap.delete(token);
      return;
    }

    // todo make this less weird (not hacky)
    // if we pass more info in the payload this will
    // need to be changed to not throw that data away
    if (isError) {
      console.log(`[Player SDK: ${VERSION}] Error received: ${payload.message}`, payload);
      // tweak payload to be the error object
      payload = new EnplugError(payload.message || '');
    }

    if (isReload) {
      console.log(`[Player SDK: ${VERSION}] App reload requested.`);
      window.location.reload();
      return;
    }

    // this is for any "public" event (these are consumed by third parties)
    if (service === 'event') {
      processEvent(action, payload, meta);
    }

  } catch (err) {
    console.error(`[Player SDK: ${VERSION}] Error receiving and processing message in _epBridge.receive`);
    console.error(err.stack);
  }

  // todo add message that call wasn't handled?
};

/**
 *  @module enplug.bridge
 */
export default {
  /*eslint consistent-return: "off"*/
  /**
   * The function for sending messages to the Java layer
   *
   * @param {object} message -- the object containing the required message parameters
   * @param {string} message.service -- the service this call belongs to
   * @param {string} message.action -- the action being preformed on this service
   * @param {object} [message.payload] -- any data required for the action being performed
   * @param {object} [message.meta] -- not currently used for anything
   * @param {boolean} [noReturn=false] -- send true to skip adding a token and returning a promise
   * @returns {Promise|undefined}
   */
  send(message, noReturn = false) {
    var msg = Object.assign({
      isNewSdk: true
    }, message);
    var url = window.location.href;

    console.log(`[Player SDK: ${VERSION}] Sending message from URL ${url}`);

    // appToken identifies specific instance of the App.
    var match = url.match(/apptoken=([^&]*[a-z|0-9])/);
    msg.appToken = match && match[1] || '';

    // We need to send app url with the message so that Web Player knows which application sent
    // a message.
    var queryIndex = url.indexOf('?');
    var appUrl = url.slice(0, queryIndex);
    msg.appUrl = appUrl;

    if (!msg.hasOwnProperty('service') || typeof msg.service !== 'string') {
      return Promise.reject(
        new TypeError(`[Player SDK: ${VERSION}] Bridge message requires a service property (string)`)
      );
    }

    if (!msg.hasOwnProperty('action') || typeof msg.action !== 'string') {
      return Promise.reject(
        new TypeError(`[Player SDK: ${VERSION}] Bridge message requires an action property (string)`)
      );
    }

    if (noReturn) {
      console.log(`[Player SDK: ${VERSION}] Message to be sent (noReturn = true): ${JSON.stringify(msg)}`);
      epBridge.send(JSON.stringify(msg));
      return;
    }

    return new Promise(function (resolve, reject) {
      var token = createToken();
      responseMap.set(token, [resolve, reject]);
      msg.token = token;

      console.log(`[Player SDK: ${VERSION}] Sending message from an App outside of Zoning: ${JSON.stringify(msg)}`, msg);
      epBridge.send(JSON.stringify(msg));
    });
  },


  /**
   * A helper for creating a send function that automatically adds the "service" property
   * based on the original input.
   *
   * @param {string} service -- the service name to add to messages
   * @returns {SenderFunction} // todo typedef
   */
  senderForService(service) {
    return (message = {}, noReturn = false) => {
      message.service = service;
      return this.send(message, noReturn);
    };
  }
};
