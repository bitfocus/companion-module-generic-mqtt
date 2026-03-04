// @ts-check
import { combineRgb, InstanceBase, InstanceStatus } from '@companion-module/base'
import { configFields } from './config.js'
import { upgradeScripts } from './upgrade.js'
import mqtt from 'mqtt'
import debounceFn from 'debounce-fn'
import objectPath from 'object-path'

export const UpgradeScripts = upgradeScripts

export default class GenericMqttInstance extends InstanceBase {
	constructor(internal) {
		super(internal)

		this.mqtt_topic_subscriptions = new Map()
		this.mqtt_topic_value_cache = new Map()

		this.debounceUpdateInstanceVariables = debounceFn(this._updateInstanceVariables, {
			wait: 100,
			before: false,
		})
	}

	async configUpdated(config) {
		this.config = config

		this._initActionDefinitions()
		this._initFeedbackDefinitions()
		this._initMqtt()
	}

	async init(config) {
		await this.configUpdated(config)
	}

	getConfigFields() {
		return configFields
	}

	async destroy() {
		this._destroyMqtt()
	}

	_resubscribeToTopics() {
		// Unsubscribe from everything
		for (const topic of this.mqtt_topic_subscriptions.values()) {
			try {
				this.mqttClient.unsubscribe(topic, (err) => {
					if (!err) {
						this.log('debug', `Successfully unsubscribed from topic: ${topic}`)
						return
					}

					this.log('debug', `Failed to unsubscribe from topic: ${topic}. Error: ${err}`)
				})
			} catch (e) {
				// Ignore
			}
		}

		this.mqtt_topic_subscriptions = new Map()
		this.mqtt_topic_value_cache = new Map()

		// And then subscribe
		this.checkAllFeedbacks()
	}

	_initFeedbackDefinitions() {
		this.setFeedbackDefinitions({
			mqtt_variable: {
				type: 'advanced',
				name: '(Deprecated) Update variable with value from MQTT topic',
				description:
					'This is deprecated and will be removed in a future release. Please update usages to store the new \'Get MQTT topic value\' feedback into a local variable.',
				options: [
					{
						type: 'textinput',
						label: 'Topic',
						id: 'subscribeTopic',
						default: '',
						useVariables: true,
					},
					{
						type: 'textinput',
						label: 'JSON Path (Blank if not json)',
						id: 'subpath',
						default: '',
					},
					{
						type: 'textinput',
						label: 'Variable',
						id: 'variable',
						default: '',
						disableAutoExpression: true,
					},
				],
				callback: (feedback) => {
					// Update subscription
					if (feedback.previousOptions?.subscribeTopic) {
						// Unsubscribe from previous topic if it exists
						this._unsubscribeToTopic(feedback.previousOptions.subscribeTopic, feedback.id)
					}

					const subData = {
						variableName: feedback.options.variable,
						subpath: feedback.options.subpath,
					}

					let subscribeTopic = (feedback.options.subscribeTopic)
					this._subscribeToTopic(subscribeTopic, feedback.id, 'mqtt_variable', subData)
					this.debounceUpdateInstanceVariables()

					// Update it if we have a cached value
					const message = this.mqtt_topic_value_cache.get(subscribeTopic)
					if (message !== undefined) {
						this._updateFeedbackVariables([[subscribeTopic, subData]])
					}

					// Nothing to do, as this feeds a variable
					return {}
				},
				unsubscribe: async (feedback) => {
					this._unsubscribeToTopic(feedback.options.subscribeTopic, feedback.id)
					this.debounceUpdateInstanceVariables()
				},
			},
			mqtt_value: {
				type: 'boolean',
				name: 'Check MQTT topic value',
				defaultStyle: {
					color: combineRgb(0, 0, 0),
					bgcolor: combineRgb(0, 255, 0),
				},
				options: [
					{
						type: 'textinput',
						label: 'Topic',
						id: 'subscribeTopic',
						default: '',
						useVariables: true,
					},
					{
						type: 'textinput',
						label: 'JSON Path (Blank if not json)',
						id: 'subpath',
						default: '',
					},
					{
						type: 'textinput',
						label: 'Value',
						id: 'value',
						default: '',
						useVariables: true,
					},
					{
						type: 'dropdown',
						label: 'Comparison',
						id: 'comparison',
						default: 'eq',
						choices: [
							{ id: 'eq', label: '=' },
							{ id: 'ne', label: '!=' },
							{ id: 'lt', label: '<' },
							{ id: 'lte', label: '<=' },
							{ id: 'gt', label: '>' },
							{ id: 'gte', label: '>=' },
						],
						disableAutoExpression:true,
					},
				],
				callback: async (feedback) => {
					// Update subscription
					if (feedback.options.subscribeTopic !== feedback.previousOptions?.subscribeTopic) {
						if (feedback.previousOptions?.subscribeTopic) {
							// Unsubscribe from previous topic if it exists
							this._unsubscribeToTopic(feedback.previousOptions.subscribeTopic, feedback.id)
						}

						let subscribeTopic = (feedback.options.subscribeTopic)
						this._subscribeToTopic(subscribeTopic, feedback.id, 'mqtt_value')
					}

					let subscribeTopic = feedback.options.subscribeTopic
					let value = this.mqtt_topic_value_cache.get(subscribeTopic)
					if (value !== undefined) {
						if (feedback.options.subpath) {
							value = objectPath.get(JSON.parse(value), feedback.options.subpath)
						}

						const targetValue = feedback.options.value
						const checks = {
							eq: value == targetValue,
							ne: value != targetValue,
							lt: value < targetValue,
							lte: value <= targetValue,
							gt: value > targetValue,
							gte: value >= targetValue,
						}
						return checks[feedback.options.comparison] || false
					}

					return false
				},
				unsubscribe: async (feedback) => {
					let subscribeTopic = feedback.options.subscribeTopic
					this._unsubscribeToTopic(subscribeTopic, feedback.id)
				},
			},
		})
	}

	_subscribeToTopic(topic, feedbackId, feedbackType, data) {
		if (!topic) return

		const subscriptions = this.mqtt_topic_subscriptions.get(topic) || {}
		if (Object.keys(subscriptions).length === 0) {
			this.mqttClient.subscribe(topic, (err) => {
				if (!err) {
					this.log('debug', `Successfully subscribed to topic: ${topic}`)
					return
				}

				this.log('debug', `Failed to subscribe to topic: ${topic}. Error: ${err}`)
			})
		}

		if (!subscriptions[feedbackId]) {
			subscriptions[feedbackId] = { ...data, type: feedbackType }
			this.mqtt_topic_subscriptions.set(topic, subscriptions)
		}
	}
	_unsubscribeToTopic(topic, feedbackId) {
		if (!topic) return
		
		const subscriptions = this.mqtt_topic_subscriptions.get(topic) || {}
		if (Object.keys(subscriptions).length !== 0 && subscriptions[feedbackId]) {
			delete subscriptions[feedbackId]
			this.mqtt_topic_subscriptions.set(topic, subscriptions)

			if (Object.keys(subscriptions).length === 0) {
				try {
					this.mqttClient.unsubscribe(topic, (err) => {
						if (this.mqtt_topic_value_cache.has(topic) && !this.mqtt_topic_subscriptions.has(topic)) {
							// Ensure cached value is pruned
							this.mqtt_topic_value_cache.delete(topic)
						}

						if (!err) {
							this.log('debug', `Successfully unsubscribed from topic: ${topic}`)
							return
						}

						this.log('debug', `Failed to unsubscribe from topic: ${topic}. Error: ${err}`)
					})
				} catch (e) {
					// Ignore
				}
			}
		}
	}

	_initActionDefinitions() {
		this.setActionDefinitions({
			publish: {
				name: 'Publish Message',
				options: [
					{
						type: 'textinput',
						label: 'Topic',
						id: 'topic',
						default: '',
						useVariables: true,
					},
					{
						type: 'textinput',
						label: 'Payload',
						id: 'payload',
						default: '',
						useVariables: true,
					},
					{
						type: 'number',
						label: 'QoS',
						id: 'qos',
						default: 0,
						min: 0,
						max: 2,
					},
					{
						type: 'checkbox',
						label: 'Retain?',
						id: 'retain',
						default: false,
					},
				],
				callback: async (action) => {
					let opt = action.options

					let topic = opt.topic
					let payload = opt.payload
					let qos = opt.qos
					let retain = opt.retain

					this.log('debug', `Sending MQTT message ${topic}: ${payload}`)

					this.mqttClient.publish(topic, payload, { qos: qos, retain: retain })
				},
			},
		})
	}

	_destroyMqtt() {
		if (this.mqttClient !== undefined) {
			this.mqttClient.end()
			delete this.mqttClient
		}
	}

	_initMqtt() {
		this._destroyMqtt()

		try {
			if (this.config.broker_ip) {
				const brokerPort = isNaN(parseInt(this.config.port)) ? '' : `:${this.config.port}`
				const brokerUrl = `${this.config.protocol}${this.config.broker_ip}${brokerPort}`

				this.updateStatus(InstanceStatus.Connecting)

				const options = {
					username: this.config.user,
					password: this.config.password,
				}

				if (this.config.clientId) {
					options.clientId = this.config.clientId
				}

				this.mqttClient = mqtt.connect(brokerUrl, options)

				this.mqttClient.on('connect', () => {
					this.updateStatus(InstanceStatus.Ok)

					this._resubscribeToTopics()
				})

				this.mqttClient.on('error', (error) => {
					this.updateStatus(InstanceStatus.UnknownError, error.message || error.toString())

					this.log('error', error.toString())

					if (this.config.restartOnError ) {
						this._destroyMqtt()

						if (!this._restartTimeout) {
							this._restartTimeout = setTimeout(() => {
								this._restartTimeout = undefined
								this._initMqtt()
							}, 1000)
						}
					}
				})

				this.mqttClient.on('offline', () => {
					this.updateStatus(InstanceStatus.Disconnected)
				})

				// this.mqttClient.on('packetreceive', packet => {
				// 	this.debug('MQTT', packet)
				// });

				this.mqttClient.on('message', (topic, message) => {
					try {
						if (topic) {
							this._handleMqttMessage(topic, message ? message.toString() : '')
						}
					} catch (e) {
						this.log('error', `Handle message faaailed: ${e.toString()}`)
					}
				})
			}
		} catch (e) {
			this.updateStatus(InstanceStatus.UnknownError, e.message || e.toString())
		}
	}

	_handleMqttMessage(topic, message) {
		// this.log(
		// 	'debug',
		// 	`MQTT message received: ${JSON.stringify({
		// 		topic: topic,
		// 		message: message,
		// 	})}`
		// )

		const subscriptions = this.mqtt_topic_subscriptions.get(topic)
		if (subscriptions) {
			this.mqtt_topic_value_cache.set(topic, message)

			const variablesToUpdate = []
			const feedbackIdsToUpdate = []

			for (const [id, data] of Object.entries(subscriptions)) {
				if (data.type === 'mqtt_variable') {
					variablesToUpdate.push([topic, data])
				} else {
					feedbackIdsToUpdate.push(id)
				}
			}

			this.checkFeedbacksById(...feedbackIdsToUpdate)
			this._updateFeedbackVariables(variablesToUpdate)
		}
	}

	_updateAllVariables() {
		const variablesToUpdate = []

		for (const [topic, subscriptions] of this.mqtt_topic_subscriptions.entries()) {
			for (const data of Object.values(subscriptions)) {
				if (data.type === 'mqtt_variable') {
					variablesToUpdate.push([topic, data])
				}
			}
		}

		this._updateFeedbackVariables(variablesToUpdate)
	}

	_updateFeedbackVariables(variables) {
		const newValues = {}

		for (const [topic, data] of variables) {
			let msgValue = this.mqtt_topic_value_cache.get(topic)
			if (msgValue) {
				if (data.subpath) {
					msgValue = objectPath.get(JSON.parse(msgValue), data.subpath)
				}

				newValues[data.variableName] = msgValue
			}
		}

		// this.log('debug', `Updating variable values: ${JSON.stringify(newValues)}`)

		this.setVariableValues(newValues)
	}

	_updateInstanceVariables() {
		const vars = {}

		for (const [key, uses] of this.mqtt_topic_subscriptions.entries()) {
			Object.values(uses).forEach((use) => {
				if (use.type === 'mqtt_variable') {
					vars[use.variableName] = {
						name: `MQTT value from topic: ${key}`,
					}
				}
			})
		}

		this.log('debug', `Refreshing variable definitions: ${JSON.stringify(vars)}`)
		this.setVariableDefinitions(vars)

		this._updateAllVariables()
	}
}

