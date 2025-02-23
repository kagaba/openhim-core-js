'use strict'

import cookie from 'cookie'
import http from 'http'
import https from 'https'
import logger from 'winston'
import zlib from 'zlib'
import {promisify} from 'util'

import * as events from '../middleware/events'
import * as messageStore from '../middleware/messageStore'
import * as utils from '../utils'
import {config} from '../config'
import {KafkaProducerManager} from '../kafkaProducerManager'

config.mongo = config.get('mongo')
config.router = config.get('router')

const isRouteEnabled = route =>
  route.status == null || route.status === 'enabled'

export function numberOfPrimaryRoutes(routes) {
  let numPrimaries = 0
  for (const route of Array.from(routes)) {
    if (isRouteEnabled(route) && route.primary) {
      numPrimaries++
    }
  }
  return numPrimaries
}

const containsMultiplePrimaries = routes => numberOfPrimaryRoutes(routes) > 1

function setKoaResponse(ctx, response) {
  // Try and parse the status to an int if it is a string
  if (typeof response.status === 'string') {
    const statusCode = parseInt(response.status, 10)
    if (isNaN(response.status)) {
      logger.error(`Failed to parse status code ${statusCode} to an int`)
    } else {
      response.status = statusCode
    }
  }

  ctx.response.status = response.status
  ctx.response.timestamp = response.timestamp
  ctx.response.body = response.body

  if (!ctx.response.header) {
    ctx.response.header = {}
  }

  if (
    ctx.request != null &&
    ctx.request.header != null &&
    ctx.request.header['X-OpenHIM-TransactionID'] != null
  ) {
    if ((response != null ? response.headers : undefined) != null) {
      response.headers['X-OpenHIM-TransactionID'] =
        ctx.request.header['X-OpenHIM-TransactionID']
    }
  }

  for (const key in response.headers) {
    const value = response.headers[key]
    switch (key.toLowerCase()) {
      case 'set-cookie':
        setCookiesOnContext(ctx, value)
        break
      case 'location':
        if (response.status >= 300 && response.status < 400) {
          ctx.response.redirect(value)
        } else {
          ctx.response.set(key, value)
        }
        break
      case 'content-type':
        ctx.response.type = value
        break
      case 'content-length':
      case 'content-encoding':
      case 'transfer-encoding':
        // Skip headers which will be set internally
        // These would otherwise interfere with the response
        break
      default:
        // Copy any other headers onto the response
        ctx.response.set(key, value)
        break
    }
  }
}

if (process.env.NODE_ENV === 'test') {
  exports.setKoaResponse = setKoaResponse
}

function setCookiesOnContext(ctx, value) {
  logger.info('Setting cookies on context')
  const result = []
  for (let cValue = 0; cValue < value.length; cValue++) {
    let pVal
    const cKey = value[cValue]
    const cOpts = {path: false, httpOnly: false} // clear out default values in cookie module
    const cVals = {}
    const object = cookie.parse(cKey)
    for (const pKey in object) {
      pVal = object[pKey]
      const pKeyL = pKey.toLowerCase()
      switch (pKeyL) {
        case 'max-age':
          cOpts.maxage = parseInt(pVal, 10)
          break
        case 'expires':
          cOpts.expires = new Date(pVal)
          break
        case 'path':
        case 'domain':
        case 'secure':
        case 'signed':
        case 'overwrite':
          cOpts[pKeyL] = pVal == 'true'
          break
        case 'httponly':
          cOpts.httpOnly = pVal
          break
        default:
          cVals[pKey] = pVal
      }
    }

    // TODO : Refactor this code when possible
    result.push(
      (() => {
        const result1 = []
        for (const pKey in cVals) {
          pVal = cVals[pKey]
          result1.push(ctx.cookies.set(pKey, pVal, cOpts))
        }
        return result1
      })()
    )
  }
  return result
}

function handleServerError(ctx, err, route) {
  ctx.autoRetry = true
  if (route) {
    route.error = {
      message: err.message,
      stack: err.stack ? err.stack : undefined
    }
  } else {
    ctx.response.status = 500
    ctx.response.timestamp = new Date()
    ctx.response.body = 'An internal server error occurred'
    // primary route error
    ctx.error = {
      message: err.message,
      stack: err.stack ? err.stack : undefined
    }
  }

  logger.error(
    `[${
      ctx.transactionId != null ? ctx.transactionId.toString() : undefined
    }] Internal server error occured: ${err}`
  )
  if (err.stack) {
    return logger.error(`${err.stack}`)
  }
}

function constructOptionsObject(ctx, route, keystore, path) {
  const options = {
    method: ctx.request.method,
    headers: ctx.request.header,
    path,
    agent: false,
    rejectUnauthorized: true,
    key: keystore.key,
    cert: keystore.cert.data
  }

  // default route types to http
  if (!route.type || route.type === 'http') {
    options.hostname = route.host
    options.port = route.port
  }

  if (route.type === 'kafka') {
    options.brokers = config.router.kafkaBrokers
    options.topic = route.kafkaTopic
  }

  if (route.cert != null) {
    options.ca = keystore.ca.id(route.cert).data
  }

  if (ctx.request.querystring) {
    options.path += `?${ctx.request.querystring}`
  }

  if (
    options.headers &&
    options.headers.authorization &&
    !route.forwardAuthHeader
  ) {
    delete options.headers.authorization
  }

  if (route.username && route.password) {
    options.auth = `${route.username}:${route.password}`
  }

  if (options.headers && options.headers.host) {
    delete options.headers.host
  }
  return options
}

function matchCodeOfPrimaryResponse(ctx, route) {
  if (!route.statusCodesCheck) return true

  const codes = route.statusCodesCheck.split(',')
  const status = ctx.response.status
  for (const code of codes) {
    if (Number(code) === status) return true
    if (code.includes('*')) return `${status}`[0] === code[0]
  }
}

function storingNonPrimaryRouteResp(ctx, route, options, path) {
  try {
    if ((route != null ? route.name : undefined) == null) {
      route = {name: route.name}
    }

    if ((route != null ? route.response : undefined) == null) {
      route.response = {
        status: 500,
        timestamp: ctx.requestTimestamp
      }
    }

    if ((route != null ? route.request : undefined) == null) {
      route.request = {
        host: options.hostname,
        port: options.port,
        path,
        headers: ctx.request.header,
        querystring: ctx.request.querystring,
        method: ctx.request.method,
        timestamp: ctx.requestTimestamp
      }
    }

    return messageStore.storeNonPrimaryResponse(ctx, route, () => {})
  } catch (err) {
    return logger.error(err)
  }
}

function sendRequestToRoutes(ctx, routes, next) {
  const firstPromises = [],
    secondaryPromises = []
  let promise = {}
  ctx.timer = new Date()

  if (containsMultiplePrimaries(routes)) {
    return next(
      new Error(
        'Cannot route transaction: Channel contains multiple primary routes and only one primary is allowed'
      )
    )
  }

  return utils.getKeystore(async (err, keystore) => {
    if (err) {
      return err
    }

    const routesToRunAfterPrimary = routes.filter(
      r => r.waitPrimaryResponse && !r.primary && isRouteEnabled(r)
    )
    const routesToRunSimultaneously = routes.filter(
      r => !routesToRunAfterPrimary.includes(r) && isRouteEnabled(r)
    )

    for (const route of Array.from(routesToRunSimultaneously)) {
      const path = getDestinationPath(route, ctx.path)
      const options = constructOptionsObject(ctx, route, keystore, path)

      if (route.primary) {
        ctx.primaryRoute = route
        promise = sendRequest(ctx, route, options)
          .then(response => {
            logger.info(`executing primary route : ${route.name}`)
            if (
              response.headers != null &&
              response.headers['content-type'] != null &&
              response.headers['content-type'].indexOf(
                'application/json+openhim'
              ) > -1
            ) {
              // handle mediator reponse
              const responseObj = JSON.parse(response.body)
              ctx.mediatorResponse = responseObj

              if (responseObj.error != null) {
                ctx.autoRetry = true
                ctx.error = responseObj.error
              }

              // then set koa response from responseObj.response
              return setKoaResponse(ctx, responseObj.response)
            } else {
              return setKoaResponse(ctx, response)
            }
          })
          .then(() => {
            logger.info('primary route completed')
            return next()
          })
          .catch(reason => {
            // on failure
            handleServerError(ctx, reason)
            return next()
          })
      } else {
        logger.info(`executing non primary: ${route.name}`)
        promise = buildNonPrimarySendRequestPromise(
          ctx,
          route,
          options,
          path
        ).then(routeObj => {
          logger.info(`Storing non primary route responses ${route.name}`)

          return storingNonPrimaryRouteResp(ctx, routeObj, options, path)
        })
      }

      firstPromises.push(promise)
    }

    await Promise.all(firstPromises).catch(err => {
      logger.error(err)
    })

    for (const route of Array.from(routesToRunAfterPrimary)) {
      const path = getDestinationPath(route, ctx.path)
      const options = constructOptionsObject(ctx, route, keystore, path)

      logger.info(`executing non primary: ${route.name}`)

      if (route.waitPrimaryResponse && matchCodeOfPrimaryResponse(ctx, route)) {
        promise = buildNonPrimarySendRequestPromise(
          ctx,
          route,
          options,
          path
        ).then(routeObj => {
          logger.info(`Storing non primary route responses ${route.name}`)

          return storingNonPrimaryRouteResp(ctx, routeObj, options, path)
        })

        secondaryPromises.push(promise)
      }
    }

    Promise.all(secondaryPromises)
      .then(() => {
        logger.info(
          `All routes completed for transaction: ${ctx.transactionId}`
        )
        // Set the final status of the transaction
        messageStore.setFinalStatus(ctx, err => {
          if (err) {
            logger.error(
              `Setting final status failed for transaction: ${ctx.transactionId}`,
              err
            )
            return
          }
          logger.debug(`Set final status for transaction: ${ctx.transactionId}`)
        })
        // Save events for the secondary routes
        if (ctx.routes) {
          const trxEvents = []
          events.createSecondaryRouteEvents(
            trxEvents,
            ctx.transactionId,
            ctx.requestTimestamp,
            ctx.authorisedChannel,
            ctx.routes,
            ctx.currentAttempt
          )
          events.saveEvents(trxEvents, err => {
            if (err) {
              logger.error(
                `Saving route events failed for transaction: ${ctx.transactionId}`,
                err
              )
              return
            }
            logger.debug(
              `Saving route events succeeded for transaction: ${ctx.transactionId}`
            )
          })
        }
      })
      .catch(err => {
        logger.error(err)
      })
  })
}

// function to build fresh promise for transactions routes
const buildNonPrimarySendRequestPromise = (ctx, route, options, path) =>
  sendRequest(ctx, route, options)
    .then(response => {
      const routeObj = {}
      routeObj.name = route.name
      routeObj.request = {
        host: options.hostname,
        port: options.port,
        path,
        headers: ctx.request.header,
        querystring: ctx.request.querystring,
        method: ctx.request.method,
        timestamp: ctx.requestTimestamp
      }

      if (
        response.headers != null &&
        response.headers['content-type'] != null &&
        response.headers['content-type'].indexOf('application/json+openhim') >
          -1
      ) {
        // handle mediator reponse
        const responseObj = JSON.parse(response.body)
        routeObj.mediatorURN = responseObj['x-mediator-urn']
        routeObj.orchestrations = responseObj.orchestrations
        routeObj.properties = responseObj.properties
        if (responseObj.metrics) {
          routeObj.metrics = responseObj.metrics
        }
        routeObj.response = responseObj.response
      } else {
        routeObj.response = response
      }

      if (!ctx.routes) {
        ctx.routes = []
      }
      ctx.routes.push(routeObj)
      return routeObj
    })
    .catch(reason => {
      // on failure
      const routeObj = {}
      routeObj.name = route.name

      if (!ctx.routes) {
        ctx.routes = []
      }
      ctx.routes.push(routeObj)

      handleServerError(ctx, reason, routeObj)
      return routeObj
    })

function sendRequest(ctx, route, options) {
  function buildOrchestration(response) {
    const orchestration = {
      name: route.name,
      request: {
        host: options.hostname,
        port: options.port,
        path: options.path,
        headers: options.headers,
        method: options.method,
        body: ctx.body,
        timestamp: ctx.requestTimestamp
      }
    }

    if (response instanceof Error) {
      orchestration.error = {
        message: response.message,
        stack: response.stack
      }
    } else {
      orchestration.response = {
        headers: response.headers,
        status: response.status,
        body: response.body,
        timestamp: response.timestamp
      }
    }

    return orchestration
  }

  function recordOrchestration(response) {
    if (!route.primary) {
      // Only record orchestrations for primary routes
      return
    }
    if (!Array.isArray(ctx.orchestrations)) {
      ctx.orchestrations = []
    }
    ctx.orchestrations.push(buildOrchestration(response))
  }

  const requestDelegate =
    route.type === 'kafka' ? sendKafkaRequest : sendHttpRequest
  return requestDelegate(ctx, route, options)
    .then(response => {
      recordOrchestration(response)
      // Return the response as before
      return response
    })
    .catch(err => {
      recordOrchestration(err)
      // Rethrow the error
      throw err
    })
}

function obtainCharset(headers) {
  const contentType = headers['content-type'] || ''
  const matches = contentType.match(/charset=([^;,\r\n]+)/i)
  if (matches && matches[1]) {
    return matches[1]
  }
  return 'utf-8'
}

/*
 * A promise returning function that send a request to the given route and resolves
 * the returned promise with a response object of the following form:
 *   response =
 *    status: <http_status code>
 *    body: <http body>
 *    headers: <http_headers_object>
 *    timestamp: <the time the response was recieved>
 */
function sendHttpRequest(ctx, route, options) {
  return new Promise((resolve, reject) => {
    const response = {}

    const gunzip = zlib.createGunzip()
    const inflate = zlib.createInflate()

    let method = http

    if (route.secured) {
      method = https
    }

    const routeReq = method.request(options, routeRes => {
      response.status = routeRes.statusCode
      response.headers = routeRes.headers

      const uncompressedBodyBufs = []
      if (routeRes.headers['content-encoding'] === 'gzip') {
        // attempt to gunzip
        routeRes.pipe(gunzip)

        gunzip.on('data', data => {
          uncompressedBodyBufs.push(data)
        })
      }

      if (routeRes.headers['content-encoding'] === 'deflate') {
        // attempt to inflate
        routeRes.pipe(inflate)

        inflate.on('data', data => {
          uncompressedBodyBufs.push(data)
        })
      }

      const bufs = []
      routeRes.on('data', chunk => bufs.push(chunk))

      // See https://www.exratione.com/2014/07/nodejs-handling-uncertain-http-response-compression/
      routeRes.on('end', () => {
        response.timestamp = new Date()
        const charset = obtainCharset(routeRes.headers)
        if (routeRes.headers['content-encoding'] === 'gzip') {
          gunzip.on('end', () => {
            const uncompressedBody = Buffer.concat(uncompressedBodyBufs)
            response.body = uncompressedBody.toString(charset)
            resolve(response)
          })
        } else if (routeRes.headers['content-encoding'] === 'deflate') {
          inflate.on('end', () => {
            const uncompressedBody = Buffer.concat(uncompressedBodyBufs)
            response.body = uncompressedBody.toString(charset)
            resolve(response)
          })
        } else {
          response.body = Buffer.concat(bufs)
          resolve(response)
        }
      })
    })

    routeReq.on('error', err => {
      reject(err)
    })

    routeReq.on('clientError', err => {
      reject(err)
    })

    const timeout =
      route.timeout != null ? route.timeout : +config.router.timeout
    routeReq.setTimeout(timeout, () => {
      routeReq.destroy(new Error(`Request took longer than ${timeout}ms`))
    })

    if (ctx.request.method === 'POST' || ctx.request.method === 'PUT') {
      if (ctx.body != null) {
        // TODO : Should probally add checks to see if the body is a buffer or string
        routeReq.write(ctx.body)
      }
    }

    routeReq.end()
  })
}

/*
 * A promise returning function that send a request to the given route using kafka producer and resolves
 * the returned promise with a response object of the following form: ()
 *   response =
 *    status: <200 if all work, else 500>
 *    body: <the received data from kafka>
 *    timestamp: <the time the response was recieved>
 */
function sendKafkaRequest(ctx, route) {
  return new Promise((resolve, reject) => {
    const timeout = route.timeout ?? +config.router.timeout
    const channel = ctx.authorisedChannel

    KafkaProducerManager.getProducer(channel.name, route.kafkaClientId, timeout)
      .then(producer => {
        const topic = route.kafkaTopic

        const message = {
          method: ctx.request.method,
          path: ctx.request.url,
          pattern: channel.urlPattern,
          headers: ctx.request.headers,
          body: ctx.body && ctx.body.toString()
        }

        return producer
          .send({
            topic,
            messages: [{value: JSON.stringify(message)}]
          })
          .then(res => {
            resolve({
              status: 200,
              body: JSON.stringify(res),
              timestamp: +new Date(),
              headers: {}
            })
          })
      })
      .catch(e => {
        reject(e)
      })
  })
}

function getDestinationPath(route, requestPath) {
  if (route.path) {
    return route.path
  } else if (route.pathTransform) {
    return transformPath(requestPath, route.pathTransform)
  } else {
    return requestPath
  }
}

/*
 * Applies a sed-like expression to the path string
 *
 * An expression takes the form s/from/to
 * Only the first 'from' match will be substituted
 * unless the global modifier as appended: s/from/to/g
 *
 * Slashes can be escaped as \/
 */
export function transformPath(path, expression) {
  // replace all \/'s with a temporary ':' char so that we don't split on those
  // (':' is safe for substitution since it cannot be part of the path)
  let fromRegex
  const sExpression = expression.replace(/\\\//g, ':')
  const sub = sExpression.split('/')

  const from = sub[1].replace(/:/g, '/')
  let to = sub.length > 2 ? sub[2] : ''
  to = to.replace(/:/g, '/')

  if (sub.length > 3 && sub[3] === 'g') {
    fromRegex = new RegExp(from, 'g')
  } else {
    fromRegex = new RegExp(from)
  }

  return path.replace(fromRegex, to)
}

/*
 * Gets the authorised channel and routes
 * the request to all routes within that channel. It updates the
 * response of the context object to reflect the response recieved from the
 * route that is marked as 'primary'.
 *
 * Accepts (ctx, next) where ctx is a [Koa](http://koajs.com/) context
 * object and next is a callback that is called once the route marked as
 * primary has returned an the ctx.response object has been updated to
 * reflect the response from that route.
 */
export function route(ctx, next) {
  const channel = ctx.authorisedChannel
  if (!isMethodAllowed(ctx, channel)) {
    next()
  } else {
    if (channel.timeout != null) {
      channel.routes.forEach(route => {
        route.timeout = channel.timeout
      })
    }
    sendRequestToRoutes(ctx, channel.routes, next)
  }
}

/**
 * Checks if the request in the current context is allowed
 *
 * @param {any} ctx Koa context, will mutate the response property if not allowed
 * @param {any} channel Channel that is getting fired against
 * @returns {Boolean}
 */
function isMethodAllowed(ctx, channel) {
  const {request: {method} = {}} = ctx || {}
  const {methods = []} = channel || {}
  if (utils.isNullOrWhitespace(method) || methods.length === 0) {
    return true
  }

  const isAllowed = methods.indexOf(method.toUpperCase()) !== -1
  if (!isAllowed) {
    logger.info(
      `Attempted to use method ${method} with channel ${
        channel.name
      } valid methods are ${methods.join(', ')}`
    )
    Object.assign(ctx.response, {
      status: 405,
      timestamp: new Date(),
      body: `Request with method ${method} is not allowed. Only ${methods.join(
        ', '
      )} methods are allowed`
    })
  }

  return isAllowed
}

/*
 * The [Koa](http://koajs.com/) middleware function that enables the
 * router to work with the Koa framework.
 *
 * Use with: app.use(router.koaMiddleware)
 */
export async function koaMiddleware(ctx, next) {
  const _route = promisify(route)
  await _route(ctx)
  await next()
}
