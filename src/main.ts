import yaml from 'yaml'
import * as fs from 'fs'
import {
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  SchemaObject
} from 'openapi3-ts'
import {PathItemObject, PathsObject} from 'openapi3-ts/src/model/OpenApi'
import path from 'path'

/**
 *
 * @param inputFilePath openapi spec file path
 */
function readInputFile(inputFilePath: string) {
  console.log('reading input file: ', inputFilePath)
  const fileContent = fs.readFileSync(inputFilePath).toString()
  const openapiObj: OpenAPIObject = yaml.parse(fileContent)
  return openapiObj
}

interface Config {
  prefix?: string,
  commonParameters?: ParameterObject[]
  commonResponse?: Record<string, SchemaObject>
}

const defaultConfig: Required<Config> = {
  prefix: '/onein',
  commonParameters: [],
  commonResponse: {}
}

/**
 *
 * @param configFilePath onein config file path
 */
function readConfigFile(configFilePath: string) {
  console.log('reading config file: ', configFilePath)
  const configObj: Config = fs.existsSync(configFilePath) ?
    yaml.parse(fs.readFileSync(configFilePath).toString()) :
    {}
  return Object.assign({}, defaultConfig, configObj) as Required<Config>
}

function addPrefix(openapiObj: OpenAPIObject, prefix: string) {
  console.log('adding prefix: ', prefix)
  const newPaths: PathsObject = {}
  for (const path in openapiObj.paths) {
    newPaths[prefix + path] = openapiObj.paths[path]
  }
  openapiObj.paths = newPaths
}

const HttpMethods = ['get', 'put', 'post', 'delete', 'head', 'options', 'trace', 'patch'] as const

/**
 * convert api format to match onein standard
 * @param openapiObj
 * @param config
 */
function convertApiFormat(openapiObj: OpenAPIObject, config: Required<Config>) {
  console.log('converting api format')
  const components = openapiObj.components ?? {}
  const schemas = components.schemas ?? {}

  createArraySchemaWrappers(schemas)
  for (const k in schemas) {
    const o = schemas[k]
    wrapPrimitiveArrays(schemas, k, o)
  }
  createPrimitiveSchemaWrappers(schemas)
  createCommonReponseSchema(schemas, config)

  const newPaths: PathsObject = {}
  for (const key in openapiObj.paths) {
    const path: PathItemObject = openapiObj.paths[key]
    for (const httpMethod of HttpMethods) {
      const operation = path[httpMethod]
      if (operation) {
        const newKey = `${key}/${httpMethod}`.replace(
          /\/{/g, '/['
        ).replace(
          /}\//g, ']/'
        )
        let newPathItem: PathItemObject = newPaths[newKey]
        if (newPathItem === undefined) {
          newPathItem = {}
          newPaths[newKey] = newPathItem
        }
        newPathItem.post = operation
        mergeParametersAndRequestBody(path, operation, schemas, config.commonParameters)
        wrapResponseBody(path, operation, schemas, config)
      }
    }
  }
  unwrapAllOfSchemas(schemas)
  cutLongDescriptions(schemas)
  components.schemas = schemas
  openapiObj.components = components
  openapiObj.paths = newPaths
}

interface WithDescription {
  description?: string
}

function cutDescription(d: WithDescription, max: number) {
  if (d.description && d.description.length > max) d.description = d.description.substring(0, max - 3) + '...'
}

function cutLongDescriptions(schemas: Record<string, SchemaObject>) {
  const max = 64 // onein platform limit
  for (const k in schemas) {
    const s = schemas[k]
    cutDescription(s, max)
    for (const pk in s.properties) {
      const p = s.properties[pk] as SchemaObject
      cutDescription(p, max)
    }
  }
}

function unwrapAllOfSchema(schemas: Record<string, SchemaObject>, schema: SchemaObject) {
  if (schema.allOf && schema.allOf.length > 0) {
    const newSchema = createSchema({
      type: 'object',
      properties: {}
    })
    for (const t of schema.allOf) {
      const it = unwrapRef(t, schemas, true)
      const p = unwrapAllOfSchema(schemas, it).properties
      Object.assign(newSchema.properties, p)
      if (it.required) addRequired(newSchema, ...it.required)
    }
    return newSchema
  } else if (schema.anyOf && schema.anyOf.length > 0) {
    const newSchema = createSchema({
      type: 'object',
      properties: {}
    })
    for (const t of schema.anyOf) {
      const it = unwrapRef(t, schemas, true)
      const p = unwrapAllOfSchema(schemas, it).properties
      Object.assign(newSchema.properties, p)
    }
    return newSchema
  } else return schema
}

function unwrapAllOfSchemas(schemas: Record<string, SchemaObject>) {
  for (const k in schemas) {
    const s = schemas[k]
    schemas[k] = unwrapAllOfSchema(schemas, s)
  }
}

function mergeParametersAndRequestBody(
  path: PathItemObject,
  operation: OperationObject,
  schemas: Record<string, SchemaObject>,
  commonParameters: ParameterObject[]
) {
  const parameters = [
    ...commonParameters,
    ...path.parameters ?? [],
    ...operation.parameters ?? []
  ] as ParameterObject[]
  if (parameters.length > 0 || operation.requestBody) { // if operation does not have req body, there is no need to set method manually
    console.log('merge parameters and requestBody for operation [%s]', operation.operationId)
    const reqBody = createSchema({
      type: 'object',
      properties: {}
    })
    for (const parameter of parameters) {
      const p = parameter
      const nameInReqObj = '_' + p.in + '_' + p.name
      const paramSchema: SchemaObject = p.schema ?? {type: 'string'}
      paramSchema.description = p.description
      if (p.required) addRequired(reqBody, nameInReqObj)
      reqBody.properties[nameInReqObj] = paramSchema
    }
    // merge parameters into new requestBody
    const reqSchemaName = '_req_' + operation.operationId
    operation.parameters = undefined
    // todo support non-json content
    const originReqBody = (operation.requestBody as RequestBodyObject | undefined)?.content['application/json']?.schema
    let finalReqBody: SchemaObject | ReferenceObject = reqBody
    if (originReqBody) {
      const originReqBodySchema = unwrapRef(originReqBody, schemas, true)
      if (originReqBodySchema.anyOf) {
        finalReqBody = createSchema({
          anyOf: [originReqBodySchema, reqBody]
        })
      } else if (originReqBodySchema.allOf) {
        finalReqBody = createSchema({
          allOf: [...originReqBodySchema.allOf, reqBody]
        })
      } else {
        Object.assign(reqBody.properties, originReqBodySchema.properties)
        if (originReqBodySchema.required) addRequired(reqBody, ...originReqBodySchema.required)
      }
    }
    // set new requestBody ref to operation
    operation.requestBody = {
      content: {
        'application/json': {
          schema: {
            $ref: refPath(reqSchemaName)
          }
        }
      }
    } as RequestBodyObject
    // deal with arrays
    schemas[reqSchemaName] = finalReqBody
  }
}

function addRequired(schema: SchemaObject, ...params: string[]) {
  if (!schema.required) schema.required = []
  schema.required.push(...params)
}

function wrapResponseBody(
  path: PathItemObject, operation: OperationObject,
  schemas: Record<string, SchemaObject>,
  config: Required<Config>
) {
  console.log('wrapping response body for operation [%s]', operation.operationId)
  const okRes = operation.responses['200'] as ResponseObject
  if (!okRes) throw new TypeError('200 response not found for operation: ' + operation.operationId)
  const contentKey = 'application/json'
  if (!okRes.content) okRes.content = {}
  if (okRes.content[contentKey]) {
    const jsonRes = okRes.content[contentKey]
    const jsonSchema = jsonRes.schema!
    const resSchemaName = '_res_' + operation.operationId
    schemas[resSchemaName] = createSchema({
      type: 'object',
      properties: Object.assign({}, config.commonResponse, {
        '_jsonBody': jsonSchema
      })
    })
    jsonRes.schema = {
      $ref: refPath(resSchemaName)
    }
  } else {
    // todo check non-json content(such as plainText) and wrap it with new json res
    okRes.content[contentKey] = {
      schema: {
        $ref: refPath(commonResponseKey)
      }
    }
  }
}

/**
 * create wrappers for array schemas
 * @param schemas
 */
function createArraySchemaWrappers(schemas: Record<string, SchemaObject>) {
  const arrayWrappers: Record<string, SchemaObject> = {}
  for (const k in schemas) {
    const schema = schemas[k]
    if (schema.type === 'array') {
      arrayWrappers['_array_' + k] = createSchema({
        type: 'object',
        properties: {
          '_v': {
            $ref: refPath(k)
          }
        },
        required: ['_v']
      })
    }
  }
  for (const k in arrayWrappers) {
    schemas[k] = arrayWrappers[k]
  }
}

/**
 * create wrappers for primitive schemas
 * @param schemas
 */
function createPrimitiveSchemaWrappers(schemas: Record<string, SchemaObject>) {
  for (const type of ['integer', 'number', 'string', 'boolean'] as const) {
    const refName = '_primitive_' + type
    schemas[refName] = createSchema({
      type: 'object',
      properties: {
        '_v': createSchema({
          type
        })
      },
      required: ['_v']
    })
  }
}

const commonResponseKey = '_commonResponse'
/**
 * create schema for common response
 * @param schemas
 * @param config
 */
function createCommonReponseSchema(schemas: Record<string, SchemaObject>, config: Required<Config>) {
  schemas[commonResponseKey] = createSchema({
    type: 'object',
    properties: Object.assign({}, config.commonResponse)
  })
}

/**
 * ignore non-object schema
 * @param schemas
 * @param schemaName
 * @param schema
 */
function wrapPrimitiveArrays(schemas: Record<string, SchemaObject>, schemaName: string, schema: SchemaObject) {
  if (schema.type === 'object') {
    for (const k in schema.properties) {
      const field = schema.properties[k]
      if (typeof field.$ref !== 'string') { // skip ref because it will be processed in top level loop
        wrapPrimitiveArray(schemas, field, `${schemaName}.${k}`)
      }
    }
  } else if (schema.type === 'array') {
    wrapPrimitiveArray(schemas, schema, schemaName)
  } // else primitive schemas
}

function wrapPrimitiveArray(schemas: Record<string, SchemaObject>, schema: SchemaObject, schemaName: string) {
  if (schema.type === 'array') {
    const itemSchema = unwrapRef(schema.items!, schemas)
    if (itemSchema.type === 'array') throw new TypeError(`unsupported nested array type: [${schemaName}]`)
    if (itemSchema.type !== 'object') {
      schema.items = {
        $ref: refPath('_primitive_' + itemSchema.type)
      } as ReferenceObject
    }
  }
}

function refPath(name: string) {
  return '#/components/schemas/' + name
}

function getSchemaNameFromRefPath(refPath: string) {
  const prefix = '#/components/schemas/'
  if (refPath.startsWith(prefix)) return refPath.substring(prefix.length)
  else throw new TypeError(`unsupported non-local ref: ${refPath}`)
}

function getSchema(schemas: Record<string, SchemaObject>, refPath: string, returnWrapType = false) {
  const schemaName = getSchemaNameFromRefPath(refPath)
  const schema = schemas[schemaName]
  if (!schema) throw new TypeError('ref target not found: ' + refPath)
  if (returnWrapType && schema.type !== 'object' && schema.type !== undefined) {
    if (schema.type === 'array') return schemas['_array_' + schemaName]
    else return schemas['_primitive_' + schema.type]
  }
  return schema
}

/**
 * unwrap ref to schema object. could not deal with complex target(such as allOf, anyOf)
 * @param item
 * @param schemas
 * @param returnWrapType
 */
function unwrapRef(item: SchemaObject | ReferenceObject, schemas: Record<string, SchemaObject>, returnWrapType = false) {
  if (typeof item.$ref === 'string')
    return getSchema(schemas, item.$ref, returnWrapType)
  else
    return item as SchemaObject
}

function createSchema<K extends keyof SchemaObject>(p: { [k in K]: SchemaObject[k] }) {
  return p as Exclude<SchemaObject, typeof p> & { [k in keyof typeof p]-?: Exclude<SchemaObject[k], undefined> }
}

function writeOutputFile(openapiObj: OpenAPIObject, outputFileNameWithoutExt: string) {
  const outputFileName = outputFileNameWithoutExt + '.onein.json'
  console.log('writing output file: ', outputFileName)
  const outputString = JSON.stringify(openapiObj, undefined, 2)
  fs.writeFileSync(outputFileName, outputString)
  return outputFileName
}

/**
 *
 * @param inputFilePath openapi spec file path(such as openapi.yaml) or dir contains it. file type should be yaml
 * @param configFilePath onein config file path. if {@link inputFilePath} is a dir, it will be used as base
 */
export function main(
  inputFilePath: string = '.',
  configFilePath: string = 'onein.yaml'
) {
  const outputFileNameWithoutExt = path.basename(path.resolve(inputFilePath), path.extname(inputFilePath))

  const stat = fs.lstatSync(inputFilePath)
  if (stat.isDirectory()) {
    const inputFileDir = inputFilePath
    inputFilePath = inputFileDir + '/openapi.yaml'
    configFilePath = inputFileDir + '/' + configFilePath
  }
  const openapiObj = readInputFile(inputFilePath)
  const configObj = readConfigFile(configFilePath)
  console.log('config: %o', configObj)

  addPrefix(openapiObj, configObj.prefix ?? '')
  convertApiFormat(openapiObj, configObj)

  return writeOutputFile(openapiObj, outputFileNameWithoutExt)
}
