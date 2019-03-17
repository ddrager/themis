import { Injectable, NotImplementedException, BadRequestException, NotFoundException } from '@nestjs/common';
import { UserService } from '../../user/user.service';
import { User } from '../../user/user.entity';
import { UserActor } from '../definitions/actors/user.actor';
import { AP } from '../definitions/constants';
import * as URI from 'uri-js';
import { ConfigService } from '../../config/config.service';
import { ActivityService } from '../activity/activity.service';
import { activityFromObject } from '../definitions/activities/create-activity';
import { ApPostService } from '../ap-post/ap-post.service';
import { UserAuthenticationService } from '../../user/user-authentication/user-authentication.service';
import { Collection } from '../definitions/activities/collection-object';
import { Group } from '../../group/group.entity';
import { compareDesc } from 'date-fns';
import { Post } from '../../post/post.entity';

/**
 * This class creates and handles actor objects representing users.
 * These are Person Actors, in ActivityPub parlance.
 *
 * @export
 * @class ApUserService
 */
@Injectable()
export class ApUserService {
    constructor(
        private readonly userService: UserService,
        private readonly configService: ConfigService,
        private readonly apPostService: ApPostService,
        private readonly activityService: ActivityService,
        private readonly accountService: UserAuthenticationService
    ) {}

    async getLocalUser(name: string): Promise<User> {
        try {
            const user = await this.userService.findLocalByName(name);

            return user;
        } catch (e) {
            Promise.reject(e);
        }
    }

    async getActorForUser(name: string): Promise<UserActor> {
        try {
            const user = await this.getLocalUser(name);

            return this.createActor(user);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    /**
     * Handle a POST request in a user's outbox. These will be AP
     * Activities, except that a bare object is also allowed; this
     * must be wrapped in a Create. Also, types are a bit wonky here,
     * so we're leaving them as "any" for the time being.
     *
     * @param username The name of the user sending the request
     * @param data The body of the request, as an AP activity or object
     * @returns The newly created activity representing the request
     * @memberof ApUserService
     */
    async acceptPostRequest(username: string, data: any): Promise<any> {
        const user = await this.userService.findLocalByName(username);

        // Strictly speaking, Activities can have content. But Themis
        // expects that to only appear on the post objects themselves.
        const activity = (data.content == null)
            ? data
            : activityFromObject(data, user); 
        
        switch (activity.type) {
            case 'Create': {
                const postObject = this.apPostService.createNewGlobalPost(activity);
                const postEntity = await this.apPostService.submitNewGlobalPost(postObject);
                const activityEntity = {
                    targetUser: user,
                    targetPost: postEntity,
                    type: activity.type,
                    activityObject: activity
                };

                // TODO: Handle delivery, etc.

                return (await this.activityService.save(activityEntity)).activityObject;
            }
            case 'Delete': {
                const deletedPost = await this.apPostService.deletePostFromActivity(activity);
                const activityEntity = {
                    targetUser: user,
                    targetPost: deletedPost,
                    type: activity.type,
                    activityObject: activity
                };

                // TODO: Handle delivery, etc.

                return (await this.activityService.save(activityEntity)).activityObject;
            }
            case 'Update':
            case 'Follow':
            case 'Add':
            case 'Remove':
                throw new NotImplementedException;
            case 'Like': {
                const likedPost = await this.apPostService.getPostEntityByUri(activity.object);

                const activityEntity = {
                    targetUser: await this.likePost(user, likedPost),
                    targetPost: likedPost,
                    type: activity.type,
                    activityObject: activity
                }

                return (await this.activityService.save(activityEntity)).activityObject;
            }
            case 'Block':
            case 'Undo':
                throw new NotImplementedException;
            default:
                throw new BadRequestException(`Invalid activity type ${activity.type}`);
        }
    }

    /**
     * Get the followers for this actor in an AP Collection.
     *
     * @param name The name of a local user
     * @returns An AP Collection object holding all following actors
     * @memberof ApUserService
     */
    async getFollowers(name: string): Promise<Collection> {
        try {
            const account = await this.accountService.findOne(name);

            const withFollowers = await this.accountService.getFollowers(account);
            const allFollowers: (Group | User)[] = withFollowers.groupFollowers
                .concat(...withFollowers.userFollowers)
                .sort((a,b) => compareDesc(a.date, b.date));

            const uris = allFollowers.map((f) => f.uri);
            return this.activityService.createCollection(uris);
        } catch (e) {
            throw new NotFoundException(`User ${name} does not exist on this server`);
        }
    }

    /**
     * Get the followed actors for this actor in an AP Collection.
     *
     * @param name The name of a local user
     * @returns An AP Collection object holding all followed actors
     * @memberof ApUserService
     */
    async getFollowing(name: string): Promise<Collection> {
        try {
            const account = await this.accountService.findOne(name);

            const withFollowing = await this.accountService.getFollowers(account);
            const allFollowing: (Group | User)[] = withFollowing.groupFollowing
                .concat(...withFollowing.userFollowing)
                .sort((a,b) => compareDesc(a.date, b.date));

            const uris = allFollowing.map((f) => f.uri);
            return this.activityService.createCollection(uris);
        } catch (e) {
            throw new NotFoundException(`User ${name} does not exist on this server`);
        }
    }

    async getLikes(name: string): Promise<Collection> {
        try {
            const user = await this.userService.findLocalByName(name);

            const withLikes = await this.userService.getLikes(user);
            const uris = withLikes.liked.map((p) => p.uri);

            return this.activityService.createCollection(uris);
        } catch (e) {
            throw new NotFoundException(`User ${name} does not exist on this server`);
        }
    }

    async likePost(user: User, post: Post): Promise<User> {
        return this.userService.addLike(user, post);
    }

    /**
     * Creates an ActivityPub Actor object for the given user entity.
     *
     * @param user The database entity representing the user
     * @returns A new Actor object for the user
     * @memberof ApUserService
     */
    createActor(user: User): UserActor {
        const idAddress = this.idForUser(user);
        return {
            '@context': AP.Context,
            id: idAddress,
            type: 'Person',
            name: user.displayName || user.name,
            preferredUsername: user.name,
            summary: user.summary,
            icon: user.icon,

            inbox: `${idAddress}/${AP.InboxAddress}/`,
            outbox: `${idAddress}/${AP.OutboxAddress}/`,
            followers: `${idAddress}/${AP.FollowersAddress}/`,
            following: `${idAddress}/${AP.FollowingAddress}/`
        }
    }

    idForUser(user: User): string {
        if (user.uri) {
            return user.uri;
        } else {
            // Same configuration needs as for groups
            const uri = URI.serialize({
                scheme: user.server.scheme,
                host: user.server.host,
                port: user.server.port,
                path: `/user/${user.name}`
            })

            return uri;
        }
    }
}
